// ─── MCP leader/follower role state ─────────────────────────────────────────
// One MCP per machine becomes the *leader*: opens the Kuzu DB in writer mode,
// runs the extraction worker, binds port 4200 for the embedded HTTP API.
//
// Other MCPs (one per Claude Code session) are *followers*: they don't open
// Kuzu, don't run a worker, and forward every tool call (working_memory,
// associate, recall_episode, consolidate) via HTTP to localhost:4200.
//
// Discovery: whoever wins the bind for port 4200 is the leader. EADDRINUSE
// means a leader is already alive — caller becomes a follower.
//
// Failover: when a follower's HTTP call fails with a connection error, it
// can call tryPromoteToLeader() to attempt taking over.

import { logger } from './logger.js';

export type Role = 'leader' | 'follower' | 'unknown';

let currentRole: Role = 'unknown';

export function getRole(): Role {
  return currentRole;
}

export function setRole(role: Role): void {
  if (currentRole !== role) {
    logger.info({ from: currentRole, to: role }, 'MCP role changed');
  }
  currentRole = role;
}

/** Base URL of the leader's HTTP API. Override via env for tests. */
export function getLeaderUrl(): string {
  return process.env.BRAINIFAI_LEADER_URL ?? 'http://127.0.0.1:4200';
}

// ─── Promotion (follower → leader) ──────────────────────────────────────────

/**
 * Hook installed by the MCP entrypoint. When a follower's HTTP call to the
 * leader fails (leader presumably died), forwarders call tryPromoteToLeader()
 * which delegates to this hook. The hook tries to take over the leader role
 * (bind port 4200, open engine, start worker). Returns true if it won.
 */
let promotionHook: (() => Promise<boolean>) | null = null;

export function installPromotionHook(fn: () => Promise<boolean>): void {
  promotionHook = fn;
}

/**
 * Attempt to promote this process to leader. Idempotent: if we're already
 * leader, returns true immediately. If no hook is installed, returns false.
 *
 * Concurrent callers within the same process serialize via the in-flight
 * promise so we never start the leader sequence twice.
 */
let promotionInFlight: Promise<boolean> | null = null;

export async function tryPromoteToLeader(): Promise<boolean> {
  if (currentRole === 'leader') return true;
  if (!promotionHook) return false;
  if (promotionInFlight) return promotionInFlight;

  promotionInFlight = (async () => {
    try {
      const won = await promotionHook!();
      if (won) setRole('leader');
      return won;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'leader promotion failed');
      return false;
    } finally {
      promotionInFlight = null;
    }
  })();

  return promotionInFlight;
}
