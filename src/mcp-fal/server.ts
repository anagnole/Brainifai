import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGenerateImage } from './tools/generate-image.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'fal-images',
    version: '0.1.0',
  });

  registerGenerateImage(server);

  return server;
}
