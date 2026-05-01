// ─── Fastify app factory ────────────────────────────────────────────────────
// Builds the viz API + static dashboard server. Used by both:
//   - src/api/server.ts  — standalone `npm run viz` mode
//   - src/mcp/index.ts   — same engine connection as MCP, dashboard sees live DB
//
// In MCP-embedded mode we disable Fastify's pino logger because MCP reserves
// stdout for the JSON-RPC transport. Caller passes `logger: false` then.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { searchRoute } from './routes/search.js';
import { neighborhoodRoute } from './routes/neighborhood.js';
import { timelineRoute } from './routes/timeline.js';
import { entityRoute } from './routes/entity.js';
import { overviewRoute } from './routes/overview.js';
import { instancesRoute } from './routes/instances.js';
import { ingestRoute } from './routes/ingest.js';
import { engineRoute } from './routes/engine.js';
import { graphInstanceRoute } from './routes/graph-instance.js';
import { sourcesRoute } from './routes/sources.js';

export interface CreateApiAppOptions {
  /** Pass `false` to suppress Fastify's pino logger (e.g. when embedded in MCP stdio). */
  logger?: boolean;
}

export async function createApiApp(opts: CreateApiAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  await app.register(fastifyCors, { origin: true });

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

  await app.register(searchRoute, { prefix: '/api' });
  await app.register(neighborhoodRoute, { prefix: '/api' });
  await app.register(timelineRoute, { prefix: '/api' });
  await app.register(entityRoute, { prefix: '/api' });
  await app.register(overviewRoute, { prefix: '/api' });
  await app.register(instancesRoute, { prefix: '/api' });
  await app.register(ingestRoute, { prefix: '/api' });
  await app.register(engineRoute, { prefix: '/api' });
  await app.register(graphInstanceRoute, { prefix: '/api' });
  await app.register(sourcesRoute, { prefix: '/api' });

  return app;
}
