import type { FastifyPluginAsync } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const LOCK_FILE = resolve(homedir(), '.brainifai', 'orchestrator.lock');
const LOG_FILE = resolve(process.cwd(), 'logs', 'brainifai.log');

export const orchestratorRoute: FastifyPluginAsync = async (app) => {
  app.get('/orchestrator/status', async () => {
    if (!existsSync(LOCK_FILE)) {
      return { locked: false };
    }

    try {
      const raw = readFileSync(LOCK_FILE, 'utf-8');
      const info = JSON.parse(raw) as { pid: number; source: string; startedAt: string };
      return { locked: true, ...info };
    } catch {
      return { locked: false, error: 'Failed to read lock file' };
    }
  });

  app.get('/orchestrator/logs', async () => {
    if (!existsSync(LOG_FILE)) {
      return { entries: [] };
    }

    try {
      const content = readFileSync(LOG_FILE, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim().length > 0);

      // Filter for orchestrator-related entries (case-insensitive)
      const orchestratorLines = lines.filter(
        (line) => /orchestrat/i.test(line),
      );

      // Take the last 50
      const last50 = orchestratorLines.slice(-50);

      const entries = last50.map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });

      return { entries };
    } catch (err) {
      return {
        entries: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
};
