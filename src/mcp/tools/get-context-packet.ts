import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildContextPacket } from '../queries/context-packet.js';

export function registerGetContextPacket(server: McpServer) {
  server.tool(
    'get_context_packet',
    'Get a comprehensive context packet for a query: anchors, facts, evidence, and optional graph slice. This is the primary tool for retrieving rich context from the knowledge graph.',
    {
      query: z.string().describe('Natural language query to find relevant context for'),
      window_days: z.number().int().min(1).max(365).default(30)
        .describe('How many days back to search'),
      limit: z.number().int().min(1).max(50).default(20)
        .describe('Maximum evidence items to return'),
    },
    async ({ query, window_days, limit }) => {
      const packet = await buildContextPacket(query, window_days, limit);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(packet, null, 2),
        }],
      };
    },
  );
}
