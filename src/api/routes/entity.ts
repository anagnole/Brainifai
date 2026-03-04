import type { FastifyPluginAsync } from 'fastify';
import { getGraphStore } from '../../shared/graphstore.js';

export const entityRoute: FastifyPluginAsync = async (app) => {
  app.get('/entity/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const store = await getGraphStore();
    const summary = await store.getEntitySummary(id);

    if (!summary) {
      return reply.status(404).send({ error: 'Entity not found' });
    }

    return summary;
  });
};
