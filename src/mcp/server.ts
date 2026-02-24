import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSearchEntities } from './tools/search-entities.js';
import { registerGetEntitySummary } from './tools/get-entity-summary.js';
import { registerGetRecentActivity } from './tools/get-recent-activity.js';
import { registerGetContextPacket } from './tools/get-context-packet.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'brainifai-pkg',
    version: '0.1.0',
  });

  registerSearchEntities(server);
  registerGetEntitySummary(server);
  registerGetRecentActivity(server);
  registerGetContextPacket(server);

  return server;
}
