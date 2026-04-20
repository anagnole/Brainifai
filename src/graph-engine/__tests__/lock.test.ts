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
});
