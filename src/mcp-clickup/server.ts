import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetLists } from './tools/get-lists.js';
import { registerListTasks } from './tools/list-tasks.js';
import { registerGetTask } from './tools/get-task.js';
import { registerCreateTask } from './tools/create-task.js';
import { registerUpdateTask } from './tools/update-task.js';
import { registerAddComment } from './tools/add-comment.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'clickup',
    version: '1.0.0',
  });

  registerGetLists(server);
  registerListTasks(server);
  registerGetTask(server);
  registerCreateTask(server);
  registerUpdateTask(server);
  registerAddComment(server);

  return server;
}
