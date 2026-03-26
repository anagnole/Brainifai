import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '../shared/logger.js';
import { spawnOrchestrator } from './spawn.js';
import { upsertBatch } from '../ingestion/upsert.js';
import { KuzuGraphStore } from '../graphstore/kuzu/adapter.js';
import { GLOBAL_BRAINIFAI_PATH } from '../instance/resolve.js';
import type { NormalizedMessage } from '../shared/types.js';
import type { InstanceContext } from './types.js';
import { ORCHESTRATOR_BATCH_MAX_CHARS, ORCHESTRATOR_BATCH_MAX_MESSAGES } from '../shared/constants.js';
import { acquireLock, releaseLock } from './lock.js';

export type { InstanceContext } from './types.js';

const GLOBAL_DB_PATH = resolve(GLOBAL_BRAINIFAI_PATH, 'data', 'kuzu');

export interface OrchestratorResult {
  source: string;
  totalMessages: number;
  routedToChildren: number;
  routedToGlobal: number;
  fallbackToGlobal: number;
  errors: string[];
}

/** Open a short-lived writable connection to the global DB, upsert, close. */
async function upsertToGlobal(messages: NormalizedMessage[]): Promise<void> {
  const store = new KuzuGraphStore({ dbPath: GLOBAL_DB_PATH, readOnly: false });
  try {
    await store.initialize();
    await upsertBatch(store, messages);
  } finally {
    await store.close();
  }
}

/**
 * Route a batch of normalized messages from a single source to child instances
 * via a Claude CLI subprocess. Global messages are written by this process.
 * Falls back to global upsert on failure.
 */
export async function orchestrateSource(
  sourceName: string,
  messages: NormalizedMessage[],
  children: InstanceContext[],
): Promise<OrchestratorResult> {
  if (!acquireLock(sourceName)) {
    logger.warn({ source: sourceName }, 'Orchestrator lock held — falling back to global');
    await upsertToGlobal(messages);
    return {
      source: sourceName,
      totalMessages: messages.length,
      routedToChildren: 0,
      routedToGlobal: 0,
      fallbackToGlobal: messages.length,
      errors: ['Orchestrator lock held by another process'],
    };
  }

  const result: OrchestratorResult = {
    source: sourceName,
    totalMessages: messages.length,
    routedToChildren: 0,
    routedToGlobal: 0,
    fallbackToGlobal: 0,
    errors: [],
  };

  // Chunk into sub-batches by total content size
  const batches: NormalizedMessage[][] = [];
  let currentBatch: NormalizedMessage[] = [];
  let currentChars = 0;

  for (const msg of messages) {
    const msgChars = msg.activity.snippet.length;
    if (currentBatch.length > 0 &&
        (currentChars + msgChars > ORCHESTRATOR_BATCH_MAX_CHARS ||
         currentBatch.length >= ORCHESTRATOR_BATCH_MAX_MESSAGES)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push(msg);
    currentChars += msgChars;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  for (const batch of batches) {
    // Write batch to temp file
    const tmpDir = mkdtempSync(join(tmpdir(), 'brainifai-batch-'));
    const batchFile = join(tmpDir, 'batch.json');
    writeFileSync(batchFile, JSON.stringify(batch, null, 2));

    try {
      const spawnResult = await spawnOrchestrator(sourceName, batchFile, batch.length, children);

      if (spawnResult.success) {
        // Write global messages via short-lived writable connection
        if (spawnResult.globalIndices.length > 0) {
          const globalMessages = spawnResult.globalIndices
            .filter(i => i >= 0 && i < batch.length)
            .map(i => batch[i]);

          if (globalMessages.length > 0) {
            await upsertToGlobal(globalMessages);
            result.routedToGlobal += globalMessages.length;
          }
        }

        result.routedToChildren += batch.length - spawnResult.globalIndices.length;
      } else {
        // Fallback: upsert entire batch to global
        logger.warn(
          { source: sourceName, error: spawnResult.error, batchSize: batch.length },
          'Orchestrator failed — falling back to global upsert',
        );
        result.errors.push(spawnResult.error ?? 'Unknown error');

        await upsertToGlobal(batch);
        result.fallbackToGlobal += batch.length;
      }
    } finally {
      try { unlinkSync(batchFile); } catch { /* ignore */ }
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    }
  }

  releaseLock();

  logger.info(
    {
      source: sourceName,
      total: result.totalMessages,
      children: result.routedToChildren,
      global: result.routedToGlobal,
      fallback: result.fallbackToGlobal,
    },
    'Orchestration complete',
  );

  return result;
}
