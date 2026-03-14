import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { resolveMcpContext } from './instance-context.js';
import { getGraphStore, closeGraphStore } from '../shared/graphstore.js';
import { logger } from '../shared/logger.js';
import { initEventBus, closeEventBus } from '../event-bus/index.js';
import { registerGlobalSubscriptions } from '../event-bus/global-subscriptions.js';

async function main() {
  // Force on-demand mode so the MCP server doesn't hold a persistent Kuzu lock.
  // This allows ingest_memory (and batch ingestion) to open write connections.
  process.env.GRAPHSTORE_ON_DEMAND = 'true';

  // Resolve instance context before anything else
  const ctx = resolveMcpContext();

  // Initialize GraphStore so queries are ready
  const store = await getGraphStore();
  await store.initialize();

  // Initialize event bus and register global subscriptions
  const bus = await initEventBus();
  registerGlobalSubscriptions(bus, ctx?.instanceName);

  const server = await createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const instanceLabel = ctx ? `${ctx.instanceName} (${ctx.instanceType})` : 'global (default)';
  logger.info(`Brainifai MCP server started — instance: ${instanceLabel}`);
}

main().catch(async (err) => {
  logger.error(err, 'MCP server failed to start');
  await closeEventBus();
  await closeGraphStore();
  process.exit(1);
});
