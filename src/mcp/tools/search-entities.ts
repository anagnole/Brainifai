import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchEntities } from '../queries/search.js';

export function registerSearchEntities(server: McpServer) {
  server.tool(
    'search_entities',
    'Search for people, topics, or channels in the knowledge graph',
    {
      query: z.string().describe('Search query text'),
      types: z.array(z.enum(['Person', 'Topic', 'Container'])).optional()
        .describe('Filter by entity type(s)'),
      limit: z.number().int().min(1).max(50).default(10)
        .describe('Maximum results to return'),
    },
    async ({ query, types, limit }) => {
      const results = await searchEntities(query, types, limit);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(results, null, 2),
        }],
      };
    },
  );
}
