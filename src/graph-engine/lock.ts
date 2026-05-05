// ─── File-based single-writer lock ──────────────────────────────────────────
// Per-instance lock file sits next to the Kuzu DB (see GraphEngineInstance.lockPath).
// Backed by proper-lockfile: handles retry, stale detection (via PID liveness
// check), and graceful release. Used by the write path, extraction worker, and
// maintenance passes to serialize writes on a single Kuzu DB.
//
// Two-layer locking:
//   1. In-process mutex (a Promise queue keyed on lockPath) serializes writers
//      within the same Node process. Instant, no fs I/O, no retry needed.
//   2. proper-lockfile takes a real OS file lock once we win the in-process
//      queue, so cross-process contention is still safe.
//
// Without layer 1, the worker's post-extraction phase (~1–10s under lock) and
// concurrent consolidate writes were both hammering proper-lockfile's retry
// loop, occasionally exhausting it before getting the lock. Now in-process
// callers funnel through a single mutex and proper-lockfile is hit just once
// per logical critical section, so its retry budget is rarely needed.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as plf from 'proper-lockfile';
import { logger } from '../shared/logger.js';

// ─── In-process mutex ───────────────────────────────────────────────────────

/** Per-lockPath promise chain. Each acquirer awaits the previous. */
const inProcessQueues = new Map<string, Promise<void>>();

async function acquireInProcess(lockPath: string): Promise<() => void> {
  const prev = inProcessQueues.get(lockPath) ?? Promise.resolve();
  let releaseInProcess!: () => void;
  const next = new Promise<void>((resolve) => {
    releaseInProcess = resolve;
  });
  // Replace the chain head with this acquirer's release-promise so the next
  // acquirer waits behind us. Map size is bounded by distinct lockPaths
  // (typically 1 per engine), so we don't bother cleaning up.
  inProcessQueues.set(lockPath, prev.then(() => next));
  await prev;
  return releaseInProcess;
}

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
  // With the in-process mutex layered above proper-lockfile, the file lock
  // is rarely contended within one process, but cross-process contention
  // (e.g. CLI commands while MCP runs) still exists. Keep the budget
  // generous: ~60s of patience worst-case.
  return {
    retries: opts?.retries?.retries ?? 80,
    minTimeout: opts?.retries?.minTimeout ?? 50,
    maxTimeout: opts?.retries?.maxTimeout ?? 1000,
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
 *
 * Layer 1: in-process mutex (instant, queues by Promise).
 * Layer 2: proper-lockfile OS file lock (cross-process safety).
 */
export async function acquireLock(lockPath: string, opts?: LockOptions): Promise<LockHandle> {
  ensureLockTarget(lockPath);

  // Layer 1: serialize within this process first. This dramatically reduces
  // contention on the file lock when worker + writeAtom + maintenance are
  // all running in the same MCP process.
  const releaseInProcess = await acquireInProcess(lockPath);

  let releaseFile: (() => Promise<void>) | null = null;
  try {
    // Layer 2: take the OS file lock. Once we own the in-process mutex, this
    // should almost always succeed on the first try unless another process
    // is also writing.
    releaseFile = await plf.lock(lockPath, {
      stale: opts?.staleMs ?? 60_000,
      retries: defaultRetryOpts(opts),
      onCompromised: (err) => {
        logger.warn({ err: err.message, lockPath }, 'lock compromised (likely stale)');
      },
    });
  } catch (err) {
    // If the file lock fails, release the in-process mutex so the queue
    // doesn't deadlock.
    releaseInProcess();
    throw err;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        if (releaseFile) await releaseFile();
      } catch (err) {
        logger.debug({ err: (err as Error).message, lockPath }, 'lock release error (ignored)');
      } finally {
        releaseInProcess();
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
