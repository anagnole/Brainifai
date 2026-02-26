import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listTasks } from '../client.js';

function formatTask(t: Awaited<ReturnType<typeof listTasks>>[number]): string {
  const due = t.due_date ? new Date(Number(t.due_date)).toLocaleDateString() : 'no due date';
  const assignees = t.assignees.map((a) => a.username).join(', ') || 'unassigned';
  return [
    `[${t.id}] ${t.name}`,
    `  Status: ${t.status.status} | Priority: ${t.priority?.priority ?? 'none'} | Due: ${due}`,
    `  Assignees: ${assignees}`,
    `  URL: ${t.url}`,
  ].join('\n');
}

export function registerListTasks(server: McpServer) {
  server.tool(
    'list_tasks',
    'List tasks in a ClickUp list, with optional status filter',
    {
      list_id: z.string().describe('The ClickUp list ID'),
      status: z.string().optional().describe('Filter by status name (e.g. "in progress", "done")'),
    },
    async ({ list_id, status }) => {
      const tasks = await listTasks(list_id, { status });

      if (tasks.length === 0) {
        const msg = status ? `No tasks with status "${status}" in list ${list_id}.` : `No tasks found in list ${list_id}.`;
        return { content: [{ type: 'text' as const, text: msg }] };
      }

      const text = `${tasks.length} task(s):\n\n` + tasks.map(formatTask).join('\n\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
