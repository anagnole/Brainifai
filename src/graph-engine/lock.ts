// ─── File-based single-writer lock ──────────────────────────────────────────
// Per-instance lock file sits next to the Kuzu DB (see GraphEngineInstance.lockPath).
// Backed by proper-lockfile: handles retry, stale detection (via PID liveness
// check), and graceful release. Used by the write path, extraction worker, and
// maintenance passes to serialize writes on a single Kuzu DB.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as plf from 'proper-lockfile';
import { logger } from '../shared/logger.js';

export interface LockOptions {
  /** Max time (ms) a lock can be held before considered stale. Default: 60s. */
  staleMs?: number;
  /** Retry config while waiting for contention. */
  retries?: {
    retries?: number;   // total retries, default 50
    minTimeout?: number; // ms, default 50
    maxTimeout?: number; // ms, default 500
    factor?: number;     // exponential backoff, default 1.5
  };
}

export interface LockHandle {
  /** Release the lock. Idempotent — no-op if already released. */
  release(): Promise<void>;
}

function defaultRetryOpts(opts?: LockOptions) {
  return {
    retries: opts?.retries?.retries ?? 50,
    minTimeout: opts?.retries?.minTimeout ?? 50,
    maxTimeout: opts?.retries?.maxTimeout ?? 500,
    factor: opts?.retries?.factor ?? 1.5,
  };
}

/**
 * proper-lockfile refuses to lock a non-existent path. Guarantee the lock's
 * target file exists (creating an empty placeholder if needed).
 */
function ensureLockTarget(lockPath: string): void {
  const parent = dirname(lockPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (!existsSync(lockPath)) writeFileSync(lockPath, '');
}

/**
 * Acquire the lock. Returns a handle whose `release()` must be called once
 * the critical section is done. Prefer `withLock` for automatic release.
 */
export async function acquireLock(lockPath: string, opts?: LockOptions): Promise<LockHandle> {
  ensureLockTarget(lockPath);

  const release = await plf.lock(lockPath, {
    stale: opts?.staleMs ?? 60_000,
    retries: defaultRetryOpts(opts),
    onCompromised: (err) => {
      logger.warn({ err: err.message, lockPath }, 'lock compromised (likely stale)');
    },
  });

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await release();
      } catch (err) {
        logger.debug({ err: (err as Error).message, lockPath }, 'lock release error (ignored)');
      }
    },
  };
}

/**
 * Run `fn` with the lock held. Releases automatically on success or failure.
 * Exceptions propagate after release.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts?: LockOptions,
): Promise<T> {
  const handle = await acquireLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

/**
 * Check if a lock is currently held, without attempting to acquire it.
 * Useful for observability / diagnostics.
 */
export async function isLocked(lockPath: string): Promise<boolean> {
  ensureLockTarget(lockPath);
  try {
    return await plf.check(lockPath, { stale: 60_000 });
  } catch {
    return false;
  }
}
