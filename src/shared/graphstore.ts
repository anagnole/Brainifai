import { resolve } from 'path';
import type { GraphStore } from '../graphstore/types.js';
import { createGraphStore } from '../graphstore/factory.js';
import { resolveInstanceDbPath, GLOBAL_BRAINIFAI_PATH } from '../instance/resolve.js';
import { logger } from './logger.js';

let store: GraphStore | null = null;
let storeDbPath: string | null = null;

/** Get or create the singleton GraphStore, configured from env vars or instance context. */
export async function getGraphStore(forDbPath?: string): Promise<GraphStore> {
  const targetPath = forDbPath ?? resolveInstanceDbPath();

  // If singleton exists but for a different path, close it first
  if (store && storeDbPath !== targetPath) {
    await closeGraphStore();
  }

  if (store) return store;

  const onDemand = process.env.GRAPHSTORE_ON_DEMAND === 'true';
  const readOnly = onDemand || process.env.GRAPHSTORE_READONLY === 'true';

  store = await createGraphStore({
    kuzu: {
      dbPath: targetPath,
      readOnly,
      onDemand,
    },
  });
  storeDbPath = targetPath;

  logger.info({ backend: 'kuzu', dbPath: targetPath }, 'GraphStore singleton created');
  return store;
}

/** Get a store that always points at the global instance DB */
export async function getGlobalGraphStore(): Promise<GraphStore> {
  const globalDbPath = resolve(GLOBAL_BRAINIFAI_PATH, 'data', 'kuzu');
  return getGraphStore(globalDbPath);
}

/** Close the singleton and null it out. */
export async function closeGraphStore(): Promise<void> {
  if (store) {
    await store.close();
    store = null;
    storeDbPath = null;
    logger.info('GraphStore singleton closed');
  }
}
