import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { addComment } from '../client.js';

export function registerAddComment(server: McpServer) {
  server.tool(
    'add_comment',
    'Add a comment to a ClickUp task',
    {
      task_id: z.string().describe('The ClickUp task ID'),
      comment: z.string().describe('Comment text to add'),
    },
    async ({ task_id, comment }) => {
      const result = await addComment(task_id, comment);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Comment added (id: ${result.id}) to task ${task_id}.`,
          },
        ],
      };
    },
  );
}
