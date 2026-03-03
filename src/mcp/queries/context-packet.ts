import { getGraphStore } from '../../shared/graphstore.js';
import { truncateEvidence } from '../safety.js';
import { DEFAULT_WINDOW_DAYS } from '../../shared/constants.js';

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

/** Resolve a search result id + type into a { label, key } pair for GraphStore. */
function toSeed(id: string, type: string): { label: string; key: Record<string, unknown> } {
  if (type === 'Person') return { label: 'Person', key: { person_key: id } };
  if (type === 'Container') {
    const colonIdx = id.indexOf(':');
    return {
      label: 'Container',
      key: {
        source: id.slice(0, colonIdx),
        container_id: id.slice(colonIdx + 1),
      },
    };
  }
  return { label: 'Topic', key: { name: id } };
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
  const store = await getGraphStore();

  // 1. ANCHOR RESOLUTION — fulltext search for top entities
  const anchors = await store.search({
    query,
    limit: 5,
    minScore: 0.3,
  });

  if (anchors.length === 0) {
    return {
      query,
      window: { start: windowStart, end: windowEnd },
      anchors: [],
      facts: [],
      evidence: [],
    };
  }

  const seeds = anchors.map((a) => toSeed(a.id, a.type));

  // 2. FACT COLLECTION — structural facts about anchors
  const factResults = await store.expand(seeds, { since: windowStart });
  const facts: string[] = factResults.map((f) => {
    let fact = `${f.name} (${f.type}): ${f.activityCount} activities in the last ${windowDays} days`;
    if (f.topRelated.length > 0) {
      fact += `. Connected to: ${f.topRelated.join(', ')}`;
    }
    return fact;
  });

  // 3. EVIDENCE GATHERING — recent activities connected to anchors
  const evidence = await store.timelineMulti(seeds, {
    from: windowStart,
    to: windowEnd,
    limit,
  });

  const cappedEvidence = truncateEvidence(
    evidence.map((e) => ({
      timestamp: e.timestamp,
      source: e.source,
      kind: e.kind,
      snippet: e.snippet,
      url: e.url,
      actor: e.actor,
      channel: e.channel,
    })),
    limit,
  );

  // 4. OPTIONAL GRAPH SLICE — small subgraph if anchors are few
  let graph_slice: ContextPacket['graph_slice'];
  if (anchors.length <= 5) {
    // Use neighborhood on first anchor seed (primary), merge if needed
    const firstSeed = seeds[0]!;
    const subgraph = await store.neighborhood(
      firstSeed.label,
      firstSeed.key,
    );
    if (subgraph.nodes.length > 0) {
      graph_slice = subgraph;
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
}
