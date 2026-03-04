import type { FastifyPluginAsync } from 'fastify';
import { getGraphStore } from '../../shared/graphstore.js';
import { resolveEntityId } from '../../graphstore/resolve-entity.js';

export const neighborhoodRoute: FastifyPluginAsync = async (app) => {
  app.get('/neighborhood', async (req, reply) => {
    const { id, maxNodes, maxEdges } = req.query as {
      id?: string;
      maxNodes?: string;
      maxEdges?: string;
    };

    if (!id) {
      return reply.status(400).send({ error: 'id parameter is required' });
    }

    const store = await getGraphStore();
    const candidates = resolveEntityId(id);

    for (const { label, key } of candidates) {
      const node = await store.getNode(label, key);
      if (node) {
        const subgraph = await store.neighborhood(label, key, {
          maxNodes: maxNodes ? parseInt(maxNodes, 10) : 30,
          maxEdges: maxEdges ? parseInt(maxEdges, 10) : 60,
        });
        return subgraph;
      }
    }

    return reply.status(404).send({ error: 'Entity not found' });
  });
};
