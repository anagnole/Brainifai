import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { getGraphStore, closeGraphStore } from '../shared/graphstore.js';
import { logger } from '../shared/logger.js';
import { searchRoute } from './routes/search.js';
import { neighborhoodRoute } from './routes/neighborhood.js';
import { timelineRoute } from './routes/timeline.js';
import { entityRoute } from './routes/entity.js';
import { overviewRoute } from './routes/overview.js';
import { instancesRoute } from './routes/instances.js';
import { ingestRoute } from './routes/ingest.js';
import { graphInstanceRoute } from './routes/graph-instance.js';
import { sourcesRoute } from './routes/sources.js';

// Force on-demand mode so the viz server doesn't hold a persistent Kuzu lock.
process.env.GRAPHSTORE_ON_DEMAND = 'true';

const app = Fastify({ logger: true });

// CORS for dev mode (Vite dev server on different port)
await app.register(fastifyCors, { origin: true });

// Serve built React app in production
const distDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../dist/viz',
);
await app.register(fastifyStatic, {
  root: distDir,
  prefix: '/',
  wildcard: false,
});

// SPA fallback: serve index.html for non-API routes
app.setNotFoundHandler(async (req, reply) => {
  if (req.url.startsWith('/api/')) {
    return reply.status(404).send({ error: 'Not found' });
  }
  return reply.sendFile('index.html');
});

// API routes
await app.register(searchRoute, { prefix: '/api' });
await app.register(neighborhoodRoute, { prefix: '/api' });
await app.register(timelineRoute, { prefix: '/api' });
await app.register(entityRoute, { prefix: '/api' });
await app.register(overviewRoute, { prefix: '/api' });
await app.register(instancesRoute, { prefix: '/api' });
await app.register(ingestRoute, { prefix: '/api' });
await app.register(graphInstanceRoute, { prefix: '/api' });
await app.register(sourcesRoute, { prefix: '/api' });

// Initialize GraphStore
const store = await getGraphStore();
await store.initialize();
logger.info('GraphStore initialized for viz server');

// Lifecycle
app.addHook('onClose', async () => {
  await closeGraphStore();
});

const port = parseInt(process.env.VIZ_PORT ?? '4200', 10);
await app.listen({ port, host: '0.0.0.0' });
logger.info({ port }, 'Viz server listening');
