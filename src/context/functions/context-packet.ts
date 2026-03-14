import { z } from 'zod';
import type { ContextFunction } from '../types.js';
import { truncateEvidence } from '../../mcp/safety.js';
import { DEFAULT_WINDOW_DAYS } from '../../shared/constants.js';

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

export const contextPacketFn: ContextFunction = {
  name: 'get_context_packet',
  description: 'Get a comprehensive context packet for a query: anchors, facts, evidence, and optional graph slice. This is the primary tool for retrieving rich context from the knowledge graph.',
  schema: {
    query: z.string().describe('Natural language query to find relevant context for'),
    window_days: z.number().int().min(1).max(365).default(30)
      .describe('How many days back to search'),
    limit: z.number().int().min(1).max(50).default(20)
      .describe('Maximum evidence items to return'),
  },
  async execute(input, store) {
    const { query, window_days, limit } = input as {
      query: string; window_days?: number; limit?: number;
    };

    const windowDays = window_days ?? DEFAULT_WINDOW_DAYS;
    const maxItems = limit ?? 20;
    const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();
    const windowEnd = new Date().toISOString();

    // 1. ANCHOR RESOLUTION — fulltext search for top entities
    const anchors = await store.search({ query, limit: 5, minScore: 0.3 });

    if (anchors.length === 0) {
      return { query, window: { start: windowStart, end: windowEnd }, anchors: [], facts: [], evidence: [] };
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
      limit: maxItems,
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
      maxItems,
    );

    // 4. OPTIONAL GRAPH SLICE — small subgraph if anchors are few
    let graph_slice: { nodes: unknown[]; edges: unknown[] } | undefined;
    if (anchors.length <= 5) {
      const firstSeed = seeds[0]!;
      const subgraph = await store.neighborhood(firstSeed.label, firstSeed.key);
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
  },
};
