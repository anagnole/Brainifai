import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getList } from '../client.js';

export function registerGetLists(server: McpServer) {
  server.tool(
    'get_lists',
    'Get the configured ClickUp lists with their names and available statuses',
    {},
    async () => {
      const listIds = (process.env.CLICKUP_LIST_IDS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);

      if (listIds.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No CLICKUP_LIST_IDS configured.' }] };
      }

      const lists = await Promise.all(listIds.map((id) => getList(id)));

      const text = lists.map((l) => {
        const statuses = l.statuses.map((s) => s.status).join(', ');
        return `• ${l.name} (id: ${l.id})\n  Statuses: ${statuses || 'none'}`;
      }).join('\n\n');

      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
