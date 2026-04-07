import type { FastifyPluginAsync } from 'fastify';
import { getGraphStore } from '../../shared/graphstore.js';
import { getCurrentDbPath } from './graph-instance.js';
import type { SubgraphNode, SubgraphEdge } from '../../graphstore/types.js';

/**
 * Returns the full graph: all People, Topics, Containers, and their
 * Activity connections.
 */
export const overviewRoute: FastifyPluginAsync = async (app) => {
  app.get('/overview', async () => {
    const dbPath = getCurrentDbPath();
    const store = await getGraphStore(dbPath ?? undefined);

    // Fetch all entity nodes
    const [people, topics, containers] = await Promise.all([
      store.findNodes('Person', {}, { limit: 500 }),
      store.findNodes('Topic', {}, { limit: 500 }),
      store.findNodes('Container', {}, { limit: 500 }),
    ]);

    const nodes: SubgraphNode[] = [];
    const nodeIds = new Set<string>();
    const edges: SubgraphEdge[] = [];
    const edgeKeys = new Set<string>();

    // Seed list for neighborhood expansion
    const seeds: Array<{ label: string; key: Record<string, unknown>; id: string }> = [];

    for (const p of people) {
      const id = p.properties.person_key as string;
      if (id && !nodeIds.has(id)) {
        nodes.push({ id, type: 'Person', name: (p.properties.display_name as string) ?? id });
        nodeIds.add(id);
        seeds.push({ label: 'Person', key: { person_key: id }, id });
      }
    }
    for (const t of topics) {
      const id = t.properties.name as string;
      if (id && !nodeIds.has(id)) {
        nodes.push({ id, type: 'Topic', name: id });
        nodeIds.add(id);
        seeds.push({ label: 'Topic', key: { name: id }, id });
      }
    }
    for (const c of containers) {
      const src = c.properties.source as string;
      const cid = c.properties.container_id as string;
      const id = `${src}:${cid}`;
      if (!nodeIds.has(id)) {
        nodes.push({ id, type: 'Container', name: (c.properties.name as string) ?? id });
        nodeIds.add(id);
        seeds.push({ label: 'Container', key: { container_id: cid, source: src }, id });
      }
    }

    // Researcher schema nodes — only present on researcher instances.
    // Each query is wrapped in try/catch so non-researcher instances are unaffected.
    const researcherTables: Array<{
      label: string;
      keyProp: string;
      nameProp?: string;
    }> = [
      { label: 'ResearchEntity', keyProp: 'entity_key', nameProp: 'name' },
      { label: 'ResearchEvent', keyProp: 'event_key', nameProp: 'title' },
      { label: 'ResearchTrend', keyProp: 'trend_key', nameProp: 'name' },
      { label: 'ResearchMetric', keyProp: 'metric_key', nameProp: 'name' },
    ];

    for (const rt of researcherTables) {
      try {
        const rows = await store.findNodes(rt.label, {}, { limit: 500 });
        for (const r of rows) {
          const id = r.properties[rt.keyProp] as string;
          if (id && !nodeIds.has(id)) {
            const name = (rt.nameProp ? (r.properties[rt.nameProp] as string) : undefined) ?? id;
            nodes.push({ id, type: rt.label, name });
            nodeIds.add(id);
            seeds.push({ label: rt.label, key: { [rt.keyProp]: id }, id });
          }
        }
      } catch (err) {
        console.error(`[overview] Failed to query ${rt.label}:`, (err as Error).message?.slice(0, 100));
      }
    }

    if (seeds.length === 0) {
      return { nodes: [], edges: [] };
    }

    // Expand each entity — merge ALL returned nodes and edges (including Activities)
    for (const seed of seeds) {
      try {
        const sub = await store.neighborhood(seed.label, seed.key, {
          maxNodes: 200,
          maxEdges: 400,
        });

        for (const n of sub.nodes) {
          if (!nodeIds.has(n.id)) {
            nodes.push(n);
            nodeIds.add(n.id);
          }
        }
        for (const e of sub.edges) {
          const ek = `${e.source}-${e.type}-${e.target}`;
          if (!edgeKeys.has(ek)) {
            edges.push(e);
            edgeKeys.add(ek);
          }
        }
      } catch {
        // Skip
      }
    }

    return { nodes, edges };
  });
};
