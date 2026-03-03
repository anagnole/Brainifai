import neo4j, { Driver, Session } from 'neo4j-driver';
import { logger } from '../../shared/logger.js';
import { NEO4J_CONSTRAINTS, NEO4J_INDEXES } from './schema.js';
import {
  GS_MAX_HOPS,
  GS_DEFAULT_HOPS,
  GS_MAX_NODES,
  GS_MAX_EDGES,
  GS_DEFAULT_SEARCH_LIMIT,
  GS_DEFAULT_TIMELINE_LIMIT,
  GS_MAX_TIMELINE_LIMIT,
  GS_DEFAULT_MIN_SCORE,
  GS_QUERY_TIMEOUT_MS,
} from '../defaults.js';
import type {
  GraphStore,
  GraphNode,
  GraphEdge,
  SearchOptions,
  SearchResult,
  TraversalOptions,
  Subgraph,
  SubgraphNode,
  SubgraphEdge,
  TimelineOptions,
  TimelineItem,
  FindFilter,
  PageOptions,
  EntitySummary,
  FactResult,
} from '../types.js';

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

function withTimeout<T>(promise: Promise<T>, ms = GS_QUERY_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Query timed out after ${ms}ms`)), ms);
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

function clampHops(n: number | undefined, def = GS_DEFAULT_HOPS): number {
  return Math.min(Math.max(n ?? def, 1), GS_MAX_HOPS);
}

/** Escape Lucene special chars and add fuzzy matching. */
function toFuzzyQuery(raw: string): string {
  const safe = raw.replace(/[+\-&|!(){}[\]^"~*?:\\\/]/g, '\\$&');
  return safe.split(/\s+/).filter(Boolean).map((w) => `${w}~`).join(' ');
}

/** Build a deterministic node ID from label + properties. */
function nodeId(label: string, props: Record<string, unknown>): string {
  if (label === 'Person') return props.person_key as string;
  if (label === 'Container') return `${props.source}:${props.container_id}`;
  if (label === 'Activity') return props.source_id as string;
  if (label === 'Topic') return props.name as string;
  if (label === 'SourceAccount') return `${props.source}:${props.account_id}`;
  if (label === 'Cursor') return `cursor:${props.source}:${props.container_id}`;
  return JSON.stringify(props);
}

/** Build the entity-resolution OPTIONAL MATCH pattern for an entityId string. */
function entityResolutionClause(idParam: string): string {
  return `
    OPTIONAL MATCH (p:Person {person_key: ${idParam}})
    OPTIONAL MATCH (t:Topic {name: ${idParam}})
    OPTIONAL MATCH (c:Container)
      WHERE c.source + ':' + c.container_id = ${idParam}
    WITH coalesce(p, t, c) AS entity
    WHERE entity IS NOT NULL`;
}

export class Neo4jGraphStore implements GraphStore {
  private driver: Driver;

  constructor(config: Neo4jConfig) {
    this.driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
    logger.info({ uri: config.uri, user: config.user }, 'Neo4jGraphStore created');
  }

  private session(): Session {
    return this.driver.session();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    const session = this.session();
    try {
      for (const stmt of [...NEO4J_CONSTRAINTS, ...NEO4J_INDEXES]) {
        await session.run(stmt);
      }
      logger.info('Neo4j schema constraints and indexes created');
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
    logger.info('Neo4jGraphStore closed');
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  async getNode(label: string, key: Record<string, unknown>): Promise<GraphNode | null> {
    const session = this.session();
    try {
      const whereClause = Object.keys(key)
        .map((k) => `n.${k} = $${k}`)
        .join(' AND ');
      const result = await withTimeout(
        session.run(
          `MATCH (n:${label}) WHERE ${whereClause} RETURN n LIMIT 1`,
          key,
        ),
      );
      const record = result.records[0];
      if (!record) return null;
      const node = record.get('n');
      return { label, properties: node.properties };
    } finally {
      await session.close();
    }
  }

  async findNodes(label: string, filter: FindFilter, page?: PageOptions): Promise<GraphNode[]> {
    const session = this.session();
    try {
      const keys = Object.keys(filter);
      const whereClause = keys.length > 0
        ? 'WHERE ' + keys.map((k) => `n.${k} = $${k}`).join(' AND ')
        : '';
      const limit = page?.limit ?? 100;
      const skip = page?.offset ?? 0;
      const result = await withTimeout(
        session.run(
          `MATCH (n:${label}) ${whereClause} RETURN n SKIP $skip LIMIT $limit`,
          { ...filter, skip: neo4j.int(skip), limit: neo4j.int(limit) },
        ),
      );
      return result.records.map((r) => {
        const node = r.get('n');
        return { label, properties: node.properties };
      });
    } finally {
      await session.close();
    }
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  async search(opts: SearchOptions): Promise<SearchResult[]> {
    const session = this.session();
    try {
      const fuzzyQuery = toFuzzyQuery(opts.query);
      const minScore = opts.minScore ?? GS_DEFAULT_MIN_SCORE;
      const limit = opts.limit ?? GS_DEFAULT_SEARCH_LIMIT;

      const typeFilter = opts.types && opts.types.length > 0
        ? `AND any(label IN labels(node) WHERE label IN $types)`
        : '';

      const result = await withTimeout(
        session.run(
          `CALL db.index.fulltext.queryNodes('entity_search', $query)
           YIELD node, score
           WHERE score > $minScore ${typeFilter}
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
           LIMIT $limit`,
          {
            query: fuzzyQuery,
            minScore,
            types: opts.types ?? [],
            limit: neo4j.int(limit),
          },
        ),
      );

      return result.records.map((r) => ({
        id: r.get('id') as string,
        type: r.get('type') as string,
        name: r.get('name') as string,
        score: r.get('score') as number,
      }));
    } finally {
      await session.close();
    }
  }

  // ─── Neighborhood ──────────────────────────────────────────────────────────

  async neighborhood(
    rootLabel: string,
    rootKey: Record<string, unknown>,
    opts?: TraversalOptions,
  ): Promise<Subgraph> {
    const session = this.session();
    try {
      const maxNodes = opts?.maxNodes ?? GS_MAX_NODES;
      const maxEdges = opts?.maxEdges ?? GS_MAX_EDGES;

      const whereClause = Object.keys(rootKey)
        .map((k) => `root.${k} = $${k}`)
        .join(' AND ');

      const labelFilter = opts?.nodeLabels && opts.nodeLabels.length > 0
        ? `AND any(label IN labels(neighbor) WHERE label IN $nodeLabels)`
        : '';

      const result = await withTimeout(
        session.run(
          `MATCH (root:${rootLabel}) WHERE ${whereClause}
           MATCH (root)<-[r1]-(neighbor)
           WHERE (neighbor:Activity OR neighbor:Person OR neighbor:Topic OR neighbor:Container)
           ${labelFilter}
           WITH DISTINCT root, neighbor, type(r1) AS relType
           LIMIT $maxEdges

           WITH collect(DISTINCT {
             id: CASE
               WHEN root:Person THEN root.person_key
               WHEN root:Container THEN root.source + ':' + root.container_id
               ELSE root.name
             END,
             type: head(labels(root)),
             name: coalesce(root.display_name, root.name)
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
               WHEN root:Person THEN root.person_key
               WHEN root:Container THEN root.source + ':' + root.container_id
               ELSE root.name
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
          {
            ...rootKey,
            maxNodes: neo4j.int(maxNodes),
            maxEdges: neo4j.int(maxEdges),
            nodeLabels: opts?.nodeLabels ?? [],
          },
        ),
      );

      const record = result.records[0];
      if (!record) return { nodes: [], edges: [] };
      return {
        nodes: record.get('nodes') as SubgraphNode[],
        edges: record.get('edges') as SubgraphEdge[],
      };
    } finally {
      await session.close();
    }
  }

  // ─── Expand (multi-seed facts) ─────────────────────────────────────────────

  async expand(
    seeds: Array<{ label: string; key: Record<string, unknown> }>,
    opts?: TraversalOptions,
  ): Promise<FactResult[]> {
    const session = this.session();
    try {
      const anchorIds = seeds.map((s) => {
        if (s.label === 'Person') return s.key.person_key as string;
        if (s.label === 'Container') return `${s.key.source}:${s.key.container_id}`;
        return s.key.name as string;
      });

      const sinceFilter = opts?.since ? 'AND a2.timestamp >= $since' : '';
      const actSinceFilter = opts?.since ? 'WHERE a.timestamp >= $since' : '';

      const result = await withTimeout(
        session.run(
          `UNWIND $anchorIds AS aid
           OPTIONAL MATCH (p:Person {person_key: aid})
           OPTIONAL MATCH (t:Topic {name: aid})
           OPTIONAL MATCH (c:Container)
             WHERE c.source + ':' + c.container_id = aid
           WITH coalesce(p, t, c) AS anchor, aid
           WHERE anchor IS NOT NULL

           OPTIONAL MATCH (anchor)<-[*1..2]-(a:Activity)
           ${actSinceFilter}
           WITH anchor, aid, count(DISTINCT a) AS actCount

           OPTIONAL MATCH (anchor)<-[*1..2]-(a2:Activity)-[*1..2]->(other)
           WHERE other <> anchor
             AND (other:Person OR other:Topic OR other:Container)
             ${sinceFilter}
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
          {
            anchorIds,
            since: opts?.since ?? null,
          },
        ),
      );

      return result.records.map((r) => ({
        name: r.get('name') as string,
        type: r.get('type') as string,
        activityCount: (r.get('actCount') as any)?.toNumber?.() ?? (r.get('actCount') as number),
        topRelated: r.get('topRelated') as string[],
      }));
    } finally {
      await session.close();
    }
  }

  // ─── Timeline ──────────────────────────────────────────────────────────────

  async timeline(
    rootLabel: string,
    rootKey: Record<string, unknown>,
    opts?: TimelineOptions,
  ): Promise<TimelineItem[]> {
    return this.timelineMulti([{ label: rootLabel, key: rootKey }], opts);
  }

  async timelineMulti(
    roots: Array<{ label: string; key: Record<string, unknown> }>,
    opts?: TimelineOptions,
  ): Promise<TimelineItem[]> {
    const session = this.session();
    try {
      const limit = Math.min(opts?.limit ?? GS_DEFAULT_TIMELINE_LIMIT, GS_MAX_TIMELINE_LIMIT);
      const hops = clampHops(opts?.hops);

      const anchorIds = roots.map((r) => {
        if (r.label === 'Person') return r.key.person_key as string;
        if (r.label === 'Container') return `${r.key.source}:${r.key.container_id}`;
        return r.key.name as string;
      });

      const timeFilters: string[] = [];
      if (opts?.from) timeFilters.push('a.timestamp >= $from');
      if (opts?.to) timeFilters.push('a.timestamp <= $to');
      if (opts?.kinds && opts.kinds.length > 0) timeFilters.push('a.kind IN $kinds');
      const timeWhere = timeFilters.length > 0 ? 'WHERE ' + timeFilters.join(' AND ') : '';

      const result = await withTimeout(
        session.run(
          `UNWIND $anchorIds AS aid
           OPTIONAL MATCH (p:Person {person_key: aid})
           OPTIONAL MATCH (t:Topic {name: aid})
           OPTIONAL MATCH (c:Container)
             WHERE c.source + ':' + c.container_id = aid
           WITH coalesce(p, t, c) AS anchor
           WHERE anchor IS NOT NULL

           MATCH (anchor)<-[*1..${hops}]-(a:Activity)
           ${timeWhere}
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
          {
            anchorIds,
            from: opts?.from ?? null,
            to: opts?.to ?? null,
            kinds: opts?.kinds ?? [],
            limit: neo4j.int(limit),
          },
        ),
      );

      return result.records.map((r) => ({
        timestamp: r.get('timestamp') as string,
        source: r.get('source') as string,
        kind: r.get('kind') as string,
        snippet: r.get('snippet') as string,
        url: r.get('url') as string | undefined,
        actor: r.get('actor') as string,
        channel: r.get('channel') as string,
      }));
    } finally {
      await session.close();
    }
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  async upsertNodes(
    label: string,
    nodes: Record<string, unknown>[],
    mergeKeys: string[],
  ): Promise<void> {
    if (nodes.length === 0) return;
    const session = this.session();
    try {
      const mergeClause = mergeKeys.map((k) => `${k}: item.${k}`).join(', ');
      const allKeys = Object.keys(nodes[0]!);
      const setKeys = allKeys.filter((k) => !mergeKeys.includes(k));
      const onCreateSet = allKeys.length > 0
        ? 'ON CREATE SET ' + allKeys.map((k) => `n.${k} = item.${k}`).join(', ')
        : '';
      const onMatchSet = setKeys.length > 0
        ? 'ON MATCH SET ' + setKeys.map((k) => `n.${k} = item.${k}`).join(', ')
        : '';

      await session.executeWrite(async (tx) => {
        await tx.run(
          `UNWIND $batch AS item
           MERGE (n:${label} {${mergeClause}})
           ${onCreateSet}
           ${onMatchSet}`,
          { batch: nodes },
        );
      });
    } finally {
      await session.close();
    }
  }

  async upsertEdges(type: string, edges: GraphEdge[]): Promise<void> {
    if (edges.length === 0) return;
    const session = this.session();
    try {
      // Group edges by label combination for efficient batching
      const groups = new Map<string, GraphEdge[]>();
      for (const edge of edges) {
        const groupKey = `${edge.fromLabel}:${edge.toLabel}`;
        const arr = groups.get(groupKey) ?? [];
        arr.push(edge);
        groups.set(groupKey, arr);
      }

      await session.executeWrite(async (tx) => {
        for (const [groupKey, batch] of groups) {
          const [fromLabel, toLabel] = groupKey.split(':');
          const fromKeys = Object.keys(batch[0]!.from);
          const toKeys = Object.keys(batch[0]!.to);

          const fromMatch = fromKeys.map((k) => `${k}: item.from_${k}`).join(', ');
          const toMatch = toKeys.map((k) => `${k}: item.to_${k}`).join(', ');

          const flatBatch = batch.map((e) => {
            const flat: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(e.from)) flat[`from_${k}`] = v;
            for (const [k, v] of Object.entries(e.to)) flat[`to_${k}`] = v;
            if (e.properties) {
              for (const [k, v] of Object.entries(e.properties)) flat[`prop_${k}`] = v;
            }
            return flat;
          });

          const propKeys = batch[0]?.properties ? Object.keys(batch[0].properties) : [];
          const propSet = propKeys.length > 0
            ? 'ON CREATE SET ' + propKeys.map((k) => `r.${k} = item.prop_${k}`).join(', ')
            : '';

          await tx.run(
            `UNWIND $batch AS item
             MATCH (a:${fromLabel} {${fromMatch}})
             MATCH (b:${toLabel} {${toMatch}})
             MERGE (a)-[r:${type}]->(b)
             ${propSet}`,
            { batch: flatBatch },
          );
        }
      });
    } finally {
      await session.close();
    }
  }

  // ─── Cursor ────────────────────────────────────────────────────────────────

  async getCursor(source: string, containerId: string): Promise<string | null> {
    const session = this.session();
    try {
      const result = await withTimeout(
        session.run(
          `MATCH (cur:Cursor {source: $source, container_id: $containerId})
           RETURN cur.latest_ts AS latest_ts`,
          { source, containerId },
        ),
      );
      const record = result.records[0];
      return record ? (record.get('latest_ts') as string) : null;
    } finally {
      await session.close();
    }
  }

  async setCursor(source: string, containerId: string, latestTs: string): Promise<void> {
    const session = this.session();
    try {
      await session.run(
        `MERGE (cur:Cursor {source: $source, container_id: $containerId})
         SET cur.latest_ts = $latestTs, cur.updated_at = datetime()`,
        { source, containerId, latestTs },
      );
    } finally {
      await session.close();
    }
  }

  // ─── Entity Summary ────────────────────────────────────────────────────────

  async getEntitySummary(entityId: string): Promise<EntitySummary | null> {
    const session = this.session();
    try {
      const result = await withTimeout(
        session.run(
          `// Try to find the entity by any key
           OPTIONAL MATCH (p:Person {person_key: $id})
           OPTIONAL MATCH (t:Topic {name: $id})
           OPTIONAL MATCH (c:Container)
             WHERE c.source + ':' + c.container_id = $id
           WITH coalesce(p, t, c) AS entity
           WHERE entity IS NOT NULL

           // Count activities
           OPTIONAL MATCH (entity)<-[*1..2]-(a:Activity)
           WITH entity, count(DISTINCT a) AS activityCount,
                max(a.timestamp) AS latestTs

           // Top connected entities (1 hop through activities)
           OPTIONAL MATCH (entity)<-[*1..2]-(a2:Activity)-[*1..2]->(other)
           WHERE other <> entity AND (other:Person OR other:Topic OR other:Container)
           WITH entity, activityCount, latestTs, other,
                head(labels(other)) AS otherType,
                coalesce(other.display_name, other.name) AS otherName,
                count(*) AS weight
           ORDER BY weight DESC
           WITH entity, activityCount, latestTs,
                collect({name: otherName, type: otherType, weight: weight})[..10] AS connections

           RETURN
             CASE
               WHEN entity:Person THEN entity.person_key
               WHEN entity:Container THEN entity.source + ':' + entity.container_id
               ELSE entity.name
             END AS id,
             head(labels(entity)) AS type,
             coalesce(entity.display_name, entity.name) AS name,
             activityCount,
             latestTs AS recentActivity,
             connections AS topConnections`,
          { id: entityId },
        ),
      );

      const record = result.records[0];
      if (!record) return null;

      return {
        id: record.get('id') as string,
        type: record.get('type') as string,
        name: record.get('name') as string,
        activityCount:
          (record.get('activityCount') as any)?.toNumber?.() ??
          (record.get('activityCount') as number),
        recentActivity: record.get('recentActivity') as string | undefined,
        topConnections: record.get('topConnections') as any[],
      };
    } finally {
      await session.close();
    }
  }

  // ─── Recent Activity ───────────────────────────────────────────────────────

  async getRecentActivity(opts: {
    personKey?: string;
    topic?: string;
    containerId?: string;
    since?: string;
    limit?: number;
  }): Promise<TimelineItem[]> {
    const session = this.session();
    try {
      const limit = Math.min(opts.limit ?? GS_DEFAULT_TIMELINE_LIMIT, GS_MAX_TIMELINE_LIMIT);
      const filters: string[] = [];
      const params: Record<string, unknown> = { limit: neo4j.int(limit) };

      if (opts.since) {
        filters.push('a.timestamp >= $since');
        params.since = opts.since;
      }
      if (opts.personKey) {
        filters.push('p.person_key = $personKey');
        params.personKey = opts.personKey;
      }
      if (opts.topic) {
        filters.push(`EXISTS { (a)-[:MENTIONS]->(:Topic {name: $topic}) }`);
        params.topic = opts.topic.toLowerCase();
      }
      if (opts.containerId) {
        filters.push('c.container_id = $containerId');
        params.containerId = opts.containerId;
      }

      const whereClause = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';

      const result = await withTimeout(
        session.run(
          `MATCH (a:Activity)-[:FROM]->(p:Person),
                (a)-[:IN]->(c:Container)
           ${whereClause}
           RETURN a.timestamp AS timestamp,
                  a.source AS source,
                  a.kind AS kind,
                  a.snippet AS snippet,
                  a.url AS url,
                  coalesce(p.display_name, p.person_key) AS actor,
                  c.name AS channel
           ORDER BY a.timestamp DESC
           LIMIT $limit`,
          params,
        ),
      );

      return result.records.map((r) => ({
        timestamp: r.get('timestamp') as string,
        source: r.get('source') as string,
        kind: r.get('kind') as string,
        snippet: r.get('snippet') as string,
        url: r.get('url') as string | undefined,
        actor: r.get('actor') as string,
        channel: r.get('channel') as string,
      }));
    } finally {
      await session.close();
    }
  }
}
