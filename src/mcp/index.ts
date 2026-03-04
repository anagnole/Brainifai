import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { getGraphStore, closeGraphStore } from '../shared/graphstore.js';
import { logger } from '../shared/logger.js';

async function main() {
  // Force on-demand mode so the MCP server doesn't hold a persistent Kuzu lock.
  // This allows ingest_memory (and batch ingestion) to open write connections.
  process.env.GRAPHSTORE_ON_DEMAND = 'true';

  // Initialize GraphStore so queries are ready
  const store = await getGraphStore();
  await store.initialize();

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Brainifai MCP server started (stdio transport)');
}

main().catch(async (err) => {
  logger.error(err, 'MCP server failed to start');
  await closeGraphStore();
  process.exit(1);
});
