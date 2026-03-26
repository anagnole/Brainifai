import type { FastifyPluginAsync } from 'fastify';
import { resolve } from 'node:path';
import { getGraphStore } from '../../shared/graphstore.js';
import { listInstances } from '../../instance/registry.js';
import { resolveInstanceDbPath, GLOBAL_BRAINIFAI_PATH } from '../../instance/resolve.js';
import { logger } from '../../shared/logger.js';

/** Track which instance name is currently active (null = default resolved path). */
let currentInstanceName: string | null = null;

export const graphInstanceRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/graph/current
   * Returns the name of the currently active graph instance.
   */
  app.get('/graph/current', async () => {
    if (currentInstanceName) {
      return { instance: currentInstanceName };
    }

    // Determine which instance the default path belongs to
    const defaultDbPath = resolveInstanceDbPath();
    try {
      const entries = await listInstances({ status: 'active' });
      for (const entry of entries) {
        const entryDbPath = resolve(entry.path, 'data', 'kuzu');
        if (entryDbPath === defaultDbPath) {
          return { instance: entry.name };
        }
      }
    } catch {
      // Registry may not be reachable — fall through
    }

    // Fallback: check if it's the global path
    const globalDbPath = resolve(GLOBAL_BRAINIFAI_PATH, 'data', 'kuzu');
    if (defaultDbPath === globalDbPath) {
      return { instance: 'global' };
    }

    return { instance: 'unknown' };
  });

  /**
   * GET /api/graph/switch/:name
   * Switches the server's GraphStore singleton to a different instance's DB.
   */
  app.get<{ Params: { name: string } }>('/graph/switch/:name', async (req, reply) => {
    const { name } = req.params;

    try {
      const entries = await listInstances({ status: 'active' });
      const entry = entries.find((e) => e.name === name);

      if (!entry) {
        return reply.status(404).send({ error: `Instance "${name}" not found` });
      }

      const dbPath = resolve(entry.path, 'data', 'kuzu');

      // getGraphStore(dbPath) will close the old store if the path differs,
      // then create a new one pointing at the target DB.
      const store = await getGraphStore(dbPath);
      await store.initialize();

      currentInstanceName = name;
      logger.info({ instance: name, dbPath }, 'Switched graph instance');

      return { ok: true, instance: name, dbPath };
    } catch (err) {
      logger.error({ err, instance: name }, 'Failed to switch graph instance');
      return reply.status(500).send({
        error: 'Failed to switch instance',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
};
