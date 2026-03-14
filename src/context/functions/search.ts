import { z } from 'zod';
import type { ContextFunction } from '../types.js';

export const searchEntitiesFn: ContextFunction = {
  name: 'search_entities',
  description: 'Search for people, topics, or channels in the knowledge graph',
  schema: {
    query: z.string().describe('Search query text'),
    types: z.array(z.enum(['Person', 'Topic', 'Container'])).optional()
      .describe('Filter by entity type(s)'),
    limit: z.number().int().min(1).max(50).default(10)
      .describe('Maximum results to return'),
  },
  async execute(input, store) {
    const { query, types, limit } = input as { query: string; types?: string[]; limit?: number };
    const results = await store.search({ query, types, limit: limit ?? 10 });
    return results;
  },
};
