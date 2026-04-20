import type { FastifyPluginAsync } from 'fastify';
import { statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { listInstances } from '../../instance/registry.js';
import { readFolderConfigAt } from '../../instance/resolve.js';
import { findInstance, updateInstance, writeFolderConfig } from '../../instance/folder-config.js';

export const instancesRoute: FastifyPluginAsync = async (app) => {
  app.get('/instances', async (_req, reply) => {
    try {
      const entries = await listInstances({ status: 'active' });

      const instances = entries.map((entry) => {
        // v2: entry.path = <folder>/.brainifai/<name>/; FolderConfig is one level up.
        const folderCfg = readFolderConfigAt(dirname(entry.path));
        const inst = folderCfg ? findInstance(folderCfg, entry.name) : null;

        let dbSizeBytes: number | null = null;
        try {
          const kuzuPath = resolve(entry.path, 'data', 'kuzu');
          const stat = statSync(kuzuPath);
          dbSizeBytes = stat.size;
        } catch { /* DB directory may not exist yet */ }

        return {
          name: entry.name,
          type: entry.type,
          description: inst?.description ?? entry.description,
          path: entry.path,
          status: entry.status,
          recentActivities: inst?.recentActivities ?? [],
          contextFunctions: inst?.contextFunctions ?? [],
          sources: inst?.sources ?? [],
          createdAt: inst?.createdAt ?? entry.createdAt,
          updatedAt: inst?.updatedAt ?? entry.updatedAt,
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

      const folderPath = dirname(entry.path);
      const folderCfg = readFolderConfigAt(folderPath);
      if (!folderCfg) {
        return reply.status(500).send({ error: `No FolderConfig at ${folderPath}` });
      }
      const inst = findInstance(folderCfg, name);
      if (!inst) {
        return reply.status(404).send({ error: `Instance "${name}" not listed in FolderConfig` });
      }

      const updated = {
        ...inst,
        description,
        updatedAt: new Date().toISOString(),
      };
      writeFolderConfig(folderPath, updateInstance(folderCfg, name, updated));

      return { ok: true, name, description };
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to update description',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
};
