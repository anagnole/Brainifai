// Standalone viz API entrypoint. Use `npm run viz` to launch.
// For the MCP-embedded variant that shares the engine connection, see
// src/mcp/index.ts which calls createApiApp() directly.

import { getGraphStore, closeGraphStore } from '../shared/graphstore.js';
import { logger } from '../shared/logger.js';
import { createApiApp } from './app.js';

// Force on-demand mode so the viz server doesn't hold a persistent Kuzu lock.
process.env.GRAPHSTORE_ON_DEMAND = 'true';

const app = await createApiApp();

// Initialize legacy GraphStore (used by non-engine routes)
const store = await getGraphStore();
await store.initialize();
logger.info('GraphStore initialized for viz server');

app.addHook('onClose', async () => {
  await closeGraphStore();
});

const port = parseInt(process.env.VIZ_PORT ?? '4200', 10);
await app.listen({ port, host: '0.0.0.0' });
logger.info({ port }, 'Viz server listening');
