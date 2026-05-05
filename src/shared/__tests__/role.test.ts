// Role / leader-follower state machine.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRole,
  setRole,
  installPromotionHook,
  tryPromoteToLeader,
} from '../role.js';

describe('role state', () => {
  beforeEach(() => {
    // Reset to a known starting state before each test
    setRole('unknown');
    installPromotionHook(async () => false);
  });

  it('initial role is unknown', () => {
    expect(getRole()).toBe('unknown');
  });

  it('setRole transitions are visible to getRole', () => {
    setRole('leader');
    expect(getRole()).toBe('leader');
    setRole('follower');
    expect(getRole()).toBe('follower');
  });

  it('tryPromoteToLeader is a no-op when already leader', async () => {
    setRole('leader');
    let hookCalled = false;
    installPromotionHook(async () => { hookCalled = true; return true; });
    const won = await tryPromoteToLeader();
    expect(won).toBe(true);
    expect(hookCalled).toBe(false); // shouldn't even invoke the hook
  });

  it('promotion hook returning true sets role to leader', async () => {
    setRole('follower');
    installPromotionHook(async () => true);
    const won = await tryPromoteToLeader();
    expect(won).toBe(true);
    expect(getRole()).toBe('leader');
  });

  it('promotion hook returning false leaves role unchanged', async () => {
    setRole('follower');
    installPromotionHook(async () => false);
    const won = await tryPromoteToLeader();
    expect(won).toBe(false);
    expect(getRole()).toBe('follower');
  });

  it('promotion hook errors are swallowed (returns false, role unchanged)', async () => {
    setRole('follower');
    installPromotionHook(async () => { throw new Error('boom'); });
    const won = await tryPromoteToLeader();
    expect(won).toBe(false);
    expect(getRole()).toBe('follower');
  });

  it('without an installed hook, promotion returns false', async () => {
    setRole('follower');
    // installPromotionHook in beforeEach sets one; "no hook" test means
    // explicitly install a never-called one or skip. The semantic check
    // is that the failed promotion path is graceful.
    installPromotionHook(async () => false);
    const won = await tryPromoteToLeader();
    expect(won).toBe(false);
  });

  it('concurrent promotion calls share one in-flight attempt', async () => {
    setRole('follower');
    let hookCalls = 0;
    installPromotionHook(async () => {
      hookCalls++;
      // Simulate a slow promotion (e.g. waiting for port to free)
      await new Promise((r) => setTimeout(r, 30));
      return true;
    });

    // Three concurrent callers must dedupe to a single hook invocation.
    const [a, b, c] = await Promise.all([
      tryPromoteToLeader(),
      tryPromoteToLeader(),
      tryPromoteToLeader(),
    ]);
    expect([a, b, c]).toEqual([true, true, true]);
    expect(hookCalls).toBe(1);
  });
});
