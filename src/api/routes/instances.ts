import type { FastifyPluginAsync } from 'fastify';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { listInstances } from '../../instance/registry.js';
import { readInstanceConfig, writeInstanceConfig } from '../../instance/resolve.js';

export const instancesRoute: FastifyPluginAsync = async (app) => {
  app.get('/instances', async (_req, reply) => {
    try {
      const entries = await listInstances({ status: 'active' });

      const instances = entries.map((entry) => {
        let config;
        try {
          config = readInstanceConfig(entry.path);
        } catch {
          // Config file may not exist — return registry data only
        }

        // Try to get DB file size
        let dbSizeBytes: number | null = null;
        try {
          const kuzuPath = resolve(entry.path, 'data', 'kuzu');
          const stat = statSync(kuzuPath);
          dbSizeBytes = stat.size;
        } catch {
          // DB directory may not exist yet
        }

        return {
          name: entry.name,
          type: entry.type,
          description: config?.description ?? entry.description,
          path: entry.path,
          status: entry.status,
          recentActivities: config?.recentActivities ?? [],
          contextFunctions: config?.contextFunctions ?? [],
          sources: config?.sources ?? [],
          createdAt: config?.createdAt ?? entry.createdAt,
          updatedAt: config?.updatedAt ?? entry.updatedAt,
          dbSizeBytes,
        };
      });

      return instances;
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to list instances',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.put<{
    Params: { name: string };
    Body: { description: string };
  }>('/instances/:name/description', async (req, reply) => {
    const { name } = req.params;
    const { description } = req.body;

    if (!description || typeof description !== 'string') {
      return reply.status(400).send({ error: 'description is required and must be a string' });
    }

    try {
      const entries = await listInstances({ status: 'active' });
      const entry = entries.find((e) => e.name === name);

      if (!entry) {
        return reply.status(404).send({ error: `Instance "${name}" not found` });
      }

      const config = readInstanceConfig(entry.path);
      config.description = description;
      config.updatedAt = new Date().toISOString();
      writeInstanceConfig(entry.path, config);

      return { ok: true, name, description };
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to update description',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
};
