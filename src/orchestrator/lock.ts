import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { GLOBAL_BRAINIFAI_PATH } from '../instance/resolve.js';
import { logger } from '../shared/logger.js';

const LOCK_FILE = resolve(GLOBAL_BRAINIFAI_PATH, 'orchestrator.lock');
const STALE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — consider lock stale after this

interface LockInfo {
  pid: number;
  source: string;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLockStale(): boolean {
  if (!existsSync(LOCK_FILE)) return false;

  try {
    const info: LockInfo = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));

    // Process died without cleaning up
    if (!isProcessAlive(info.pid)) return true;

    // Lock is too old
    const age = Date.now() - new Date(info.startedAt).getTime();
    if (age > STALE_TIMEOUT_MS) return true;

    return false;
  } catch {
    // Can't parse lock file — treat as stale
    return true;
  }
}

/**
 * Acquire the orchestrator lock. Returns true if acquired, false if another
 * orchestrator is already running.
 */
export function acquireLock(source: string): boolean {
  if (existsSync(LOCK_FILE)) {
    if (isLockStale()) {
      logger.warn('Removing stale orchestrator lock');
      try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    } else {
      const info: LockInfo = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
      logger.info(
        { lockedBy: info.source, pid: info.pid, since: info.startedAt },
        'Orchestrator lock held by another process',
      );
      return false;
    }
  }

  const info: LockInfo = {
    pid: process.pid,
    source,
    startedAt: new Date().toISOString(),
  };

  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  writeFileSync(LOCK_FILE, JSON.stringify(info));
  return true;
}

/** Release the orchestrator lock. Only releases if we own it. */
export function releaseLock(): void {
  if (!existsSync(LOCK_FILE)) return;

  try {
    const info: LockInfo = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
    if (info.pid === process.pid) {
      unlinkSync(LOCK_FILE);
    }
  } catch {
    // Best effort
    try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  }
}
