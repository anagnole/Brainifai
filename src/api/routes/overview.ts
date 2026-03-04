import type { FastifyPluginAsync } from 'fastify';
import { getGraphStore } from '../../shared/graphstore.js';

/**
 * Returns seed entities for the initial graph view.
 * Fetches a few Person and Topic nodes, then expands their neighborhoods.
 */
export const overviewRoute: FastifyPluginAsync = async (app) => {
  app.get('/overview', async () => {
    const store = await getGraphStore();

    // Get a handful of people and topics to seed the graph
    const [people, topics] = await Promise.all([
      store.findNodes('Person', {}, { limit: 5 }),
      store.findNodes('Topic', {}, { limit: 5 }),
    ]);

    // Build seed list for neighborhood expansion
    const seeds: Array<{ label: string; key: Record<string, unknown> }> = [];

    for (const p of people) {
      const pk = p.properties.person_key;
      if (pk) seeds.push({ label: 'Person', key: { person_key: pk } });
    }
    for (const t of topics) {
      const name = t.properties.name;
      if (name) seeds.push({ label: 'Topic', key: { name } });
    }

    if (seeds.length === 0) {
      return { nodes: [], edges: [] };
    }

    // Expand the first seed to get a connected subgraph
    const subgraph = await store.neighborhood(seeds[0].label, seeds[0].key, {
      maxNodes: 40,
      maxEdges: 80,
    });

    // If we got a decent graph from the first seed, merge a second
    if (seeds.length > 1 && subgraph.nodes.length < 20) {
      const sub2 = await store.neighborhood(seeds[1].label, seeds[1].key, {
        maxNodes: 30,
        maxEdges: 60,
      });
      // Merge nodes
      const nodeIds = new Set(subgraph.nodes.map((n) => n.id));
      for (const n of sub2.nodes) {
        if (!nodeIds.has(n.id)) {
          subgraph.nodes.push(n);
          nodeIds.add(n.id);
        }
      }
      // Merge edges
      const edgeKeys = new Set(
        subgraph.edges.map((e) => `${e.source}-${e.type}-${e.target}`),
      );
      for (const e of sub2.edges) {
        const key = `${e.source}-${e.type}-${e.target}`;
        if (!edgeKeys.has(key)) {
          subgraph.edges.push(e);
        }
      }
    }

    return subgraph;
  });
};
