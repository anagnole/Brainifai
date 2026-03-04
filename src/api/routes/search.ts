import type { FastifyPluginAsync } from 'fastify';
import { getGraphStore } from '../../shared/graphstore.js';

export const searchRoute: FastifyPluginAsync = async (app) => {
  app.get('/search', async (req, reply) => {
    const { q, types, limit } = req.query as {
      q?: string;
      types?: string;
      limit?: string;
    };

    if (!q || q.trim().length === 0) {
      return reply.status(400).send({ error: 'q parameter is required' });
    }

    const store = await getGraphStore();
    const results = await store.search({
      query: q.trim(),
      types: types ? types.split(',') : undefined,
      limit: limit ? parseInt(limit, 10) : 10,
    });

    return results;
  });
};
