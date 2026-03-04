import type { FastifyPluginAsync } from 'fastify';
import { getGraphStore } from '../../shared/graphstore.js';
import { resolveEntityId } from '../../graphstore/resolve-entity.js';

export const timelineRoute: FastifyPluginAsync = async (app) => {
  app.get('/timeline', async (req, reply) => {
    const { id, from, to, limit } = req.query as {
      id?: string;
      from?: string;
      to?: string;
      limit?: string;
    };

    if (!id) {
      return reply.status(400).send({ error: 'id parameter is required' });
    }

    const store = await getGraphStore();
    const candidates = resolveEntityId(id);

    for (const { label, key } of candidates) {
      const node = await store.getNode(label, key);
      if (node) {
        const items = await store.timeline(label, key, {
          from: from ?? undefined,
          to: to ?? undefined,
          limit: limit ? parseInt(limit, 10) : 20,
        });
        return items;
      }
    }

    return reply.status(404).send({ error: 'Entity not found' });
  });
};
