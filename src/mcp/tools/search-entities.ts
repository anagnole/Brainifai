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
      include_ephemeral: z.boolean().default(false)
        .describe('Include ephemeral topics (branch names, status values)'),
    },
    async ({ query, types, limit, include_ephemeral }) => {
      const results = await searchEntities(query, types, limit, include_ephemeral);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(results, null, 2),
        }],
      };
    },
  );
}
