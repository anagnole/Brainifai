import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { closeDriver } from '../shared/neo4j.js';
import { logger } from '../shared/logger.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Brainifai MCP server started (stdio transport)');
}

main().catch(async (err) => {
  logger.error(err, 'MCP server failed to start');
  await closeDriver();
  process.exit(1);
});
