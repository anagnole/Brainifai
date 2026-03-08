import { homedir } from 'os';
import { resolve } from 'path';
import type { GraphStore } from '../graphstore/types.js';
import type { GraphStoreBackend } from '../graphstore/factory.js';
import { createGraphStore } from '../graphstore/factory.js';
import { logger } from './logger.js';

const DEFAULT_KUZU_DB_PATH = resolve(homedir(), '.brainifai', 'data', 'kuzu');

let store: GraphStore | null = null;

/** Get or create the singleton GraphStore, configured from env vars. */
export async function getGraphStore(): Promise<GraphStore> {
  if (store) return store;

  const backend = (process.env.GRAPHSTORE_BACKEND ?? 'kuzu') as GraphStoreBackend;

  if (backend === 'neo4j') {
    const password = process.env.NEO4J_PASSWORD;
    if (!password) throw new Error('NEO4J_PASSWORD environment variable is required');
    store = await createGraphStore({
      backend: 'neo4j',
      neo4j: {
        uri: process.env.NEO4J_URI ?? 'bolt://localhost:7687',
        user: process.env.NEO4J_USER ?? 'neo4j',
        password,
      },
    });
  } else if (backend === 'kuzu') {
    const onDemand = process.env.GRAPHSTORE_ON_DEMAND === 'true';
    const readOnly = onDemand || process.env.GRAPHSTORE_READONLY === 'true';
    store = await createGraphStore({
      backend: 'kuzu',
      kuzu: {
        dbPath: process.env.KUZU_DB_PATH ?? DEFAULT_KUZU_DB_PATH,
        readOnly,
        onDemand,
      },
    });
  } else {
    throw new Error(`Unknown GRAPHSTORE_BACKEND: ${backend}`);
  }

  logger.info({ backend }, 'GraphStore singleton created');
  return store;
}

/** Close the singleton and null it out. */
export async function closeGraphStore(): Promise<void> {
  if (store) {
    await store.close();
    store = null;
    logger.info('GraphStore singleton closed');
  }
}
