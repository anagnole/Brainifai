import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTask } from '../client.js';

export function registerGetTask(server: McpServer) {
  server.tool(
    'get_task',
    'Get full details of a ClickUp task by ID',
    {
      task_id: z.string().describe('The ClickUp task ID'),
    },
    async ({ task_id }) => {
      const t = await getTask(task_id);

      const due = t.due_date ? new Date(Number(t.due_date)).toLocaleDateString() : 'no due date';
      const assignees = t.assignees.map((a) => a.username).join(', ') || 'unassigned';

      const lines = [
        `[${t.id}] ${t.name}`,
        `  List: ${t.list.name} (${t.list.id})`,
        `  Status: ${t.status.status} | Priority: ${t.priority?.priority ?? 'none'} | Due: ${due}`,
        `  Assignees: ${assignees}`,
        `  Created by: ${t.creator.username}`,
        `  URL: ${t.url}`,
      ];

      if (t.description) {
        lines.push(`\nDescription:\n${t.description}`);
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}
