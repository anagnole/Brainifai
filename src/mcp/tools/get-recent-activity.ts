import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getRecentActivity } from '../queries/activity.js';

export function registerGetRecentActivity(server: McpServer) {
  server.tool(
    'get_recent_activity',
    'Fetch recent activities with optional filters by person, topic, or channel',
    {
      person_key: z.string().optional()
        .describe('Filter by person (e.g. "slack:U12345")'),
      topic: z.string().optional()
        .describe('Filter by topic name'),
      container_id: z.string().optional()
        .describe('Filter by channel/container ID'),
      window_days: z.number().int().min(1).max(365).default(7)
        .describe('How many days back to look'),
      limit: z.number().int().min(1).max(50).default(20)
        .describe('Maximum results to return'),
    },
    async ({ person_key, topic, container_id, window_days, limit }) => {
      const items = await getRecentActivity({
        personKey: person_key,
        topic,
        containerId: container_id,
        windowDays: window_days,
        limit,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(items, null, 2),
        }],
      };
    },
  );
}
