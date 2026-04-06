/**
 * Researcher context functions — 5 research domain query tools.
 *
 * Exposes the researcher knowledge graph (entities, events, trends, metrics)
 * via MCP tools. Uses ResearcherGraphStore adapter with read-only access.
 */

import { z } from 'zod';
import type { ContextFunction } from '../types.js';
import { ResearcherGraphStore } from '../../graphstore/kuzu/researcher-adapter.js';
import { resolveInstanceDbPath } from '../../instance/resolve.js';

async function withResearcherStore<T>(fn: (store: ResearcherGraphStore) => Promise<T>): Promise<T> {
  const dbPath = resolveInstanceDbPath();
  const store = new ResearcherGraphStore({ dbPath, readOnly: true });
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

/** Subtract `days` from now and return an ISO 8601 date string. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ─── 1. get_landscape ────────────────────────────────────────────────────────

export const getLandscapeFn: ContextFunction = {
  name: 'get_landscape',
  description:
    'Get an overview of top entities, recent events, and active trends in a domain over a time window',
  schema: {
    domain: z.string().describe('Research domain to query'),
    days: z.number().int().min(1).default(7)
      .describe('Look-back window in days'),
    limit: z.number().int().min(1).max(50).default(20)
      .describe('Maximum items per category'),
  },
  async execute(input) {
    const { domain, days, limit } = input as {
      domain: string;
      days?: number;
      limit?: number;
    };
    const since = daysAgo(days ?? 7);
    return withResearcherStore((store) =>
      store.getLandscape(domain, since, limit ?? 20),
    );
  },
};

// ─── 2. get_entity_timeline ──────────────────────────────────────────────────

export const getEntityTimelineFn: ContextFunction = {
  name: 'get_entity_timeline',
  description: 'Get chronological event history for a specific entity',
  schema: {
    entity_name: z.string().describe('Name of the entity'),
    limit: z.number().int().min(1).max(100).default(30)
      .describe('Maximum events to return'),
  },
  async execute(input) {
    const { entity_name, limit } = input as {
      entity_name: string;
      limit?: number;
    };
    return withResearcherStore((store) =>
      store.getEntityTimeline(entity_name, limit ?? 30),
    );
  },
};

// ─── 3. get_trending ─────────────────────────────────────────────────────────

export const getTrendingFn: ContextFunction = {
  name: 'get_trending',
  description:
    'Compare entity and trend activity between current and previous time windows to find what is spiking',
  schema: {
    domain: z.string().describe('Research domain to query'),
    current_days: z.number().int().min(1).default(3)
      .describe('Current window in days'),
    compare_days: z.number().int().min(1).default(7)
      .describe('Comparison window in days (starts before current window)'),
  },
  async execute(input) {
    const { domain, current_days, compare_days } = input as {
      domain: string;
      current_days?: number;
      compare_days?: number;
    };
    const currentSince = daysAgo(current_days ?? 3);
    const compareSince = daysAgo(compare_days ?? 7);
    return withResearcherStore((store) =>
      store.getTrending(domain, currentSince, compareSince),
    );
  },
};

// ─── 4. get_entity_network ───────────────────────────────────────────────────

export const getEntityNetworkFn: ContextFunction = {
  name: 'get_entity_network',
  description:
    'Get the relationship graph around a specific entity — related entities, shared events, and metrics',
  schema: {
    entity_name: z.string().describe('Name of the entity'),
    depth: z.number().int().min(1).max(2).default(1)
      .describe('Relationship traversal depth'),
  },
  async execute(input) {
    const { entity_name, depth } = input as {
      entity_name: string;
      depth?: number;
    };
    return withResearcherStore((store) =>
      store.getEntityNetwork(entity_name, depth ?? 1),
    );
  },
};

// ─── 5. search_events ────────────────────────────────────────────────────────

export const searchEventsFn: ContextFunction = {
  name: 'search_events',
  description:
    'Full-text search across events by title and description, optionally filtered by domain and event type',
  schema: {
    query: z.string().describe('Search text'),
    domain: z.string().optional().describe('Filter by domain'),
    event_type: z.string().optional().describe('Filter by event type'),
    limit: z.number().int().min(1).max(50).default(20)
      .describe('Maximum results to return'),
  },
  async execute(input) {
    const { query, domain, event_type } = input as {
      query: string;
      domain?: string;
      event_type?: string;
      limit?: number;
    };
    return withResearcherStore((store) =>
      store.searchEvents(query, {
        domain,
        eventType: event_type,
      }),
    );
  },
};
