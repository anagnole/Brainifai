import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updateTask } from '../client.js';

export function registerUpdateTask(server: McpServer) {
  server.tool(
    'update_task',
    'Update fields on an existing ClickUp task',
    {
      task_id: z.string().describe('The ClickUp task ID to update'),
      name: z.string().optional().describe('New task title'),
      description: z.string().optional().describe('New description (replaces existing)'),
      status: z.string().optional().describe('New status (e.g. "in progress", "done")'),
      priority: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe('Priority: 1=urgent, 2=high, 3=normal, 4=low'),
      due_date: z
        .string()
        .optional()
        .describe('New due date as ISO 8601 string (e.g. "2025-12-31")'),
    },
    async ({ task_id, name, description, status, priority, due_date }) => {
      const fields: Parameters<typeof updateTask>[1] = {};
      if (name) fields.name = name;
      if (description !== undefined) fields.description = description;
      if (status) fields.status = status;
      if (priority) fields.priority = priority;
      if (due_date) fields.due_date = new Date(due_date).getTime();

      const t = await updateTask(task_id, fields);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Task updated:\n[${t.id}] ${t.name}\n  Status: ${t.status.status}\n  URL: ${t.url}`,
          },
        ],
      };
    },
  );
}
