import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSearchEntities } from './tools/search-entities.js';
import { registerGetEntitySummary } from './tools/get-entity-summary.js';
import { registerGetRecentActivity } from './tools/get-recent-activity.js';
import { registerGetContextPacket } from './tools/get-context-packet.js';
import { registerIngestMemory } from './tools/ingest-memory.js';
import { registerUpdateDescription } from './tools/update-description.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'brainifai-pkg',
    version: '0.1.0',
  });

  registerSearchEntities(server);
  registerGetEntitySummary(server);
  registerGetRecentActivity(server);
  registerGetContextPacket(server);
  registerIngestMemory(server);
  registerUpdateDescription(server);

  return server;
}
