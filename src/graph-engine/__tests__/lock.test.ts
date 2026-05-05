// Lock integration tests — uses temp directories and real proper-lockfile.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, withLock, isLocked } from '../lock.js';

describe('lock', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function mkLockPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lock-test-'));
    tmpDirs.push(dir);
    return join(dir, 'write.lock');
  }

  it('acquireLock → release works', async () => {
    const lockPath = mkLockPath();
    const handle = await acquireLock(lockPath);
    expect(await isLocked(lockPath)).toBe(true);
    await handle.release();
    expect(await isLocked(lockPath)).toBe(false);
  });

  it('release is idempotent', async () => {
    const handle = await acquireLock(mkLockPath());
    await handle.release();
    await expect(handle.release()).resolves.not.toThrow();
  });

  it('withLock runs fn and releases automatically', async () => {
    const lockPath = mkLockPath();
    let insideLock = false;
    await withLock(lockPath, async () => {
      insideLock = await isLocked(lockPath);
    });
    expect(insideLock).toBe(true);
    expect(await isLocked(lockPath)).toBe(false);
  });

  it('withLock releases on thrown exception', async () => {
    const lockPath = mkLockPath();
    await expect(withLock(lockPath, async () => {
      throw new Error('kaboom');
    })).rejects.toThrow('kaboom');
    expect(await isLocked(lockPath)).toBe(false);
  });

  it('serializes concurrent withLock calls', async () => {
    const lockPath = mkLockPath();
    const order: string[] = [];
    const taskA = withLock(lockPath, async () => {
      order.push('A-start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('A-end');
    });
    // Small delay so A is guaranteed to acquire first
    await new Promise((r) => setTimeout(r, 5));
    const taskB = withLock(lockPath, async () => {
      order.push('B-start');
      order.push('B-end');
    });
    await Promise.all([taskA, taskB]);
    expect(order).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
  });

  // Regression for Bug 2: many concurrent in-process writers used to exhaust
  // proper-lockfile's retry budget when one held the lock for a long write
  // phase. With the in-process mutex layered on top, the inner ones queue
  // instantly via Promise chaining and don't need any file-lock retries.
  it('serializes 10 concurrent in-process writers without exhausting retries', async () => {
    const lockPath = mkLockPath();
    const order: number[] = [];
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(
        withLock(lockPath, async () => {
          order.push(i);
          // Hold long enough that without an in-process queue, parallel
          // acquirers would all hit proper-lockfile and contend.
          await new Promise((r) => setTimeout(r, 30));
        }),
      );
    }
    await Promise.all(tasks);
    // All 10 ran, in fully serialized FIFO order.
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await isLocked(lockPath)).toBe(false);
  });

  // Regression for the failure-cleanup path: if proper-lockfile's plf.lock
  // throws (e.g. cross-process contention exhausts retries), we must release
  // the in-process mutex so the queue isn't deadlocked for subsequent callers.
  it('releases the in-process mutex when an inner critical section throws', async () => {
    const lockPath = mkLockPath();
    await expect(withLock(lockPath, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    // A subsequent acquirer must not be blocked by a leaked in-process mutex.
    let ran = false;
    await withLock(lockPath, async () => { ran = true; });
    expect(ran).toBe(true);
  });
});
