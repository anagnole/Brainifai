import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getEntitySummary } from '../queries/summary.js';

export function registerGetEntitySummary(server: McpServer) {
  server.tool(
    'get_entity_summary',
    'Get a summary of an entity including activity count and top connections',
    {
      entity_id: z.string().describe(
        'Entity identifier: person_key (e.g. "slack:U12345"), topic name, or "source:container_id"',
      ),
    },
    async ({ entity_id }) => {
      const summary = await getEntitySummary(entity_id);
      if (!summary) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'Entity not found' }),
          }],
          isError: true,
        };
      }

      // Format as readable markdown for the LLM
      const lines = [
        `## ${summary.name} (${summary.type})`,
        `**Activities:** ${summary.activityCount}`,
      ];
      if (summary.recentActivity) {
        lines.push(`**Most recent:** ${summary.recentActivity}`);
      }
      if (summary.topConnections.length > 0) {
        lines.push('', '**Top connections:**');
        for (const conn of summary.topConnections) {
          lines.push(`- ${conn.name} (${conn.type}) — ${conn.weight} shared activities`);
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n'),
        }],
      };
    },
  );
}
