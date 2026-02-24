import neo4j from 'neo4j-driver';
import { getSession } from '../../shared/neo4j.js';
import { withTimeout, truncateEvidence } from '../safety.js';
import { DEFAULT_WINDOW_DAYS, MAX_GRAPH_NODES, MAX_GRAPH_EDGES } from '../../shared/constants.js';

export interface Anchor {
  id: string;
  type: string;
  name: string;
  score: number;
}

export interface EvidenceItem {
  timestamp: string;
  source: string;
  kind: string;
  snippet: string;
  url?: string;
  actor: string;
  channel: string;
}

export interface GraphNode {
  id: string;
  type: string;
  name: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface ContextPacket {
  query: string;
  window: { start: string; end: string };
  anchors: Anchor[];
  facts: string[];
  evidence: EvidenceItem[];
  graph_slice?: { nodes: GraphNode[]; edges: GraphEdge[] };
}

/**
 * Build a context packet: the primary high-value abstraction.
 * Given a query, find anchors, gather facts and evidence from the graph.
 */
export async function buildContextPacket(
  query: string,
  windowDays: number = DEFAULT_WINDOW_DAYS,
  limit: number = 20,
): Promise<ContextPacket> {
  const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();
  const windowEnd = new Date().toISOString();
  const session = getSession();

  try {
    // 1. ANCHOR RESOLUTION — fulltext search for top entities
    const safeQuery = query.replace(/[+\-&|!(){}[\]^"~*?:\\\/]/g, '\\$&');
    const fuzzyQuery = safeQuery.split(/\s+/).map((w) => `${w}~`).join(' ');

    const anchorResult = await withTimeout(
      session.run(
        `CALL db.index.fulltext.queryNodes('entity_search', $query)
         YIELD node, score
         WHERE score > 0.3
         RETURN
           CASE
             WHEN node:Person THEN node.person_key
             WHEN node:Container THEN node.source + ':' + node.container_id
             ELSE node.name
           END AS id,
           head(labels(node)) AS type,
           coalesce(node.display_name, node.name) AS name,
           score
         ORDER BY score DESC
         LIMIT 5`,
        { query: fuzzyQuery },
      ),
    );

    const anchors: Anchor[] = anchorResult.records.map((r) => ({
      id: r.get('id') as string,
      type: r.get('type') as string,
      name: r.get('name') as string,
      score: r.get('score') as number,
    }));

    // If no anchors found, return empty packet
    if (anchors.length === 0) {
      return {
        query,
        window: { start: windowStart, end: windowEnd },
        anchors: [],
        facts: [],
        evidence: [],
      };
    }

    const anchorIds = anchors.map((a) => a.id);

    // 2. FACT COLLECTION — structural facts about anchors
    const factsResult = await withTimeout(
      session.run(
        `UNWIND $anchorIds AS aid

         // Find anchor node
         OPTIONAL MATCH (p:Person {person_key: aid})
         OPTIONAL MATCH (t:Topic {name: aid})
         OPTIONAL MATCH (c:Container)
           WHERE c.source + ':' + c.container_id = aid
         WITH coalesce(p, t, c) AS anchor, aid
         WHERE anchor IS NOT NULL

         // Count activities in window
         OPTIONAL MATCH (anchor)<-[*1..2]-(a:Activity)
         WHERE a.timestamp >= $windowStart
         WITH anchor, aid, count(DISTINCT a) AS actCount

         // Top related entities
         OPTIONAL MATCH (anchor)<-[*1..2]-(a2:Activity)-[*1..2]->(other)
         WHERE other <> anchor
           AND (other:Person OR other:Topic OR other:Container)
           AND a2.timestamp >= $windowStart
         WITH anchor, aid, actCount, other,
              coalesce(other.display_name, other.name) AS otherName,
              head(labels(other)) AS otherType,
              count(*) AS weight
         ORDER BY weight DESC
         WITH anchor, aid, actCount,
              collect(otherName + ' (' + otherType + ')')[..3] AS topRelated

         RETURN coalesce(anchor.display_name, anchor.name) AS name,
                head(labels(anchor)) AS type,
                actCount,
                topRelated`,
        { anchorIds, windowStart },
      ),
    );

    const facts: string[] = [];
    for (const r of factsResult.records) {
      const name = r.get('name') as string;
      const type = r.get('type') as string;
      const count = (r.get('actCount') as any)?.toNumber?.() ?? r.get('actCount');
      const related = r.get('topRelated') as string[];
      let fact = `${name} (${type}): ${count} activities in the last ${windowDays} days`;
      if (related.length > 0) {
        fact += `. Connected to: ${related.join(', ')}`;
      }
      facts.push(fact);
    }

    // 3. EVIDENCE GATHERING — recent activities connected to anchors
    const evidenceResult = await withTimeout(
      session.run(
        `UNWIND $anchorIds AS aid
         OPTIONAL MATCH (p:Person {person_key: aid})
         OPTIONAL MATCH (t:Topic {name: aid})
         OPTIONAL MATCH (c:Container)
           WHERE c.source + ':' + c.container_id = aid
         WITH coalesce(p, t, c) AS anchor
         WHERE anchor IS NOT NULL

         MATCH (anchor)<-[*1..2]-(a:Activity)
         WHERE a.timestamp >= $windowStart
           AND a.timestamp <= $windowEnd
         WITH DISTINCT a

         MATCH (a)-[:FROM]->(person:Person)
         MATCH (a)-[:IN]->(chan:Container)
         RETURN a.timestamp AS timestamp,
                a.source AS source,
                a.kind AS kind,
                a.snippet AS snippet,
                a.url AS url,
                coalesce(person.display_name, person.person_key) AS actor,
                chan.name AS channel
         ORDER BY a.timestamp DESC
         LIMIT $limit`,
        { anchorIds, windowStart, windowEnd, limit: neo4j.int(limit) },
      ),
    );

    const evidence: EvidenceItem[] = evidenceResult.records.map((r) => ({
      timestamp: r.get('timestamp') as string,
      source: r.get('source') as string,
      kind: r.get('kind') as string,
      snippet: r.get('snippet') as string,
      url: r.get('url') as string | undefined,
      actor: r.get('actor') as string,
      channel: r.get('channel') as string,
    }));

    const cappedEvidence = truncateEvidence(evidence, limit);

    // 4. OPTIONAL GRAPH SLICE — small subgraph if anchors are few
    let graph_slice: ContextPacket['graph_slice'];
    if (anchors.length <= 5) {
      const graphResult = await withTimeout(
        session.run(
          `UNWIND $anchorIds AS aid
           OPTIONAL MATCH (p:Person {person_key: aid})
           OPTIONAL MATCH (t:Topic {name: aid})
           OPTIONAL MATCH (c:Container)
             WHERE c.source + ':' + c.container_id = aid
           WITH coalesce(p, t, c) AS anchor
           WHERE anchor IS NOT NULL

           MATCH (anchor)<-[r1]-(neighbor)
           WHERE neighbor:Activity OR neighbor:Person OR neighbor:Topic OR neighbor:Container
           WITH DISTINCT anchor, neighbor, type(r1) AS relType
           LIMIT $maxEdges

           WITH collect(DISTINCT {
             id: CASE
               WHEN anchor:Person THEN anchor.person_key
               WHEN anchor:Container THEN anchor.source + ':' + anchor.container_id
               ELSE anchor.name
             END,
             type: head(labels(anchor)),
             name: coalesce(anchor.display_name, anchor.name)
           }) +
           collect(DISTINCT {
             id: CASE
               WHEN neighbor:Person THEN neighbor.person_key
               WHEN neighbor:Container THEN neighbor.source + ':' + neighbor.container_id
               WHEN neighbor:Activity THEN neighbor.source_id
               ELSE neighbor.name
             END,
             type: head(labels(neighbor)),
             name: coalesce(neighbor.display_name, neighbor.name, neighbor.snippet, neighbor.source_id)
           }) AS allNodes,
           collect(DISTINCT {
             source: CASE
               WHEN anchor:Person THEN anchor.person_key
               WHEN anchor:Container THEN anchor.source + ':' + anchor.container_id
               ELSE anchor.name
             END,
             target: CASE
               WHEN neighbor:Person THEN neighbor.person_key
               WHEN neighbor:Container THEN neighbor.source + ':' + neighbor.container_id
               WHEN neighbor:Activity THEN neighbor.source_id
               ELSE neighbor.name
             END,
             type: relType
           }) AS edges

           UNWIND allNodes AS n
           WITH collect(DISTINCT n)[..$maxNodes] AS nodes, edges
           RETURN nodes, edges`,
          { anchorIds, maxNodes: neo4j.int(MAX_GRAPH_NODES), maxEdges: neo4j.int(MAX_GRAPH_EDGES) },
        ),
      );

      const gRecord = graphResult.records[0];
      if (gRecord) {
        graph_slice = {
          nodes: gRecord.get('nodes') as GraphNode[],
          edges: gRecord.get('edges') as GraphEdge[],
        };
      }
    }

    return {
      query,
      window: { start: windowStart, end: windowEnd },
      anchors,
      facts,
      evidence: cappedEvidence,
      graph_slice,
    };
  } finally {
    await session.close();
  }
}
