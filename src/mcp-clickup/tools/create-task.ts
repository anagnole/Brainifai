import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTask } from '../client.js';

export function registerCreateTask(server: McpServer) {
  server.tool(
    'create_task',
    'Create a new ClickUp task in a list',
    {
      list_id: z.string().describe('The ClickUp list ID to create the task in'),
      name: z.string().describe('Task title'),
      description: z.string().optional().describe('Task description (markdown supported)'),
      status: z.string().optional().describe('Initial status (e.g. "open", "in progress")'),
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
        .describe('Due date as ISO 8601 string (e.g. "2025-12-31")'),
      assignee_ids: z
        .array(z.number())
        .optional()
        .describe('Array of ClickUp user IDs to assign'),
    },
    async ({ list_id, name, description, status, priority, due_date, assignee_ids }) => {
      const fields: Parameters<typeof createTask>[1] = { name };
      if (description) fields.description = description;
      if (status) fields.status = status;
      if (priority) fields.priority = priority;
      if (due_date) fields.due_date = new Date(due_date).getTime();
      if (assignee_ids) fields.assignees = assignee_ids;

      const t = await createTask(list_id, fields);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Task created:\n[${t.id}] ${t.name}\n  Status: ${t.status.status}\n  URL: ${t.url}`,
          },
        ],
      };
    },
  );
}
