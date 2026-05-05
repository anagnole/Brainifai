// ─── Engine singletons by DB path ───────────────────────────────────────────
// One `GraphEngineInstance` per distinct Kuzu DB path, plus an optional
// worker attached to each. Used by per-instance function layers to avoid
// re-opening Kuzu for every call.

import { GraphEngineInstance } from './instance.js';
import { startWorker, type WorkerHandle, type WorkerOptions } from './worker.js';
import type { SchemaSpec } from './types.js';
import { logger } from '../shared/logger.js';

interface Entry {
  engine: GraphEngineInstance;
  worker?: WorkerHandle;
}

const registry = new Map<string, Entry>();

/**
 * In-flight initialization promises, keyed by dbPath. Without this, two
 * concurrent callers of `getEngine` for the same dbPath would each construct
 * a fresh `GraphEngineInstance` and race for the OS-level Kuzu file lock —
 * one wins, the rest crash with "Could not set lock on file". Cache the
 * Promise so concurrent callers all await the same initialization.
 */
const initInFlight = new Map<string, Promise<GraphEngineInstance>>();

/**
 * Get (or lazily open) a GraphEngineInstance for the given DB path + spec.
 * Subsequent calls with the same dbPath reuse the same engine — callers
 * should not mix specs on one DB.
 *
 * Concurrency-safe: parallel calls for the same dbPath all observe the same
 * in-flight initialization and resolve to the same engine instance.
 */
export async function getEngine(
  dbPath: string,
  spec: SchemaSpec,
): Promise<GraphEngineInstance> {
  const existing = registry.get(dbPath);
  if (existing) return existing.engine;

  const inFlight = initInFlight.get(dbPath);
  if (inFlight) return inFlight;

  const initPromise = (async () => {
    const engine = new GraphEngineInstance({ spec, dbPath });
    await engine.initialize();
    registry.set(dbPath, { engine });
    return engine;
  })();
  initInFlight.set(dbPath, initPromise);

  try {
    return await initPromise;
  } finally {
    initInFlight.delete(dbPath);
  }
}

/**
 * Start the extraction worker for an engine. Idempotent — a second call on
 * the same DB path returns the existing handle.
 */
export function ensureWorker(
  engine: GraphEngineInstance,
  options?: WorkerOptions,
): WorkerHandle {
  const entry = registry.get(engine.dbPath);
  if (!entry) throw new Error(`Engine not registered for ${engine.dbPath}`);
  if (entry.worker) return entry.worker;
  const worker = startWorker(engine, options);
  entry.worker = worker;
  return worker;
}

/** Close one engine + its worker. Removes the entry from the registry. */
export async function closeEngine(dbPath: string): Promise<void> {
  initInFlight.delete(dbPath);
  const entry = registry.get(dbPath);
  if (!entry) return;
  if (entry.worker) {
    try { await entry.worker.stop(); } catch { /* ignore */ }
  }
  try { await entry.engine.close(); } catch { /* ignore */ }
  registry.delete(dbPath);
}

/** Close every registered engine + worker. Safe to call on process shutdown. */
export async function closeAllEngines(): Promise<void> {
  const paths = [...registry.keys()];
  for (const p of paths) await closeEngine(p);
  logger.debug({ count: paths.length }, 'closed all graph engines');
}
