// ─── ExtractionJob queue ────────────────────────────────────────────────────
// Stores the async LLM-extraction queue as rows in the same Kuzu DB as the
// atoms. Callers (write path, worker) hold the single-writer lock around
// enqueue/claim/complete/fail operations. No SQL-level concurrency required.

import kuzu from 'kuzu';
import { ulid } from 'ulid';
import type { ClaimedJob, JobStatus } from './types.js';
import { logger } from '../shared/logger.js';

type Conn = InstanceType<typeof kuzu.Connection>;

// ─── Re-export the row-shape used by claimNextJob ───────────────────────────

export type { ClaimedJob } from './types.js';

// ─── Enqueue ────────────────────────────────────────────────────────────────

/**
 * Add a new job to the queue. Returns the generated job id.
 * Caller must hold the write lock.
 */
export async function enqueueJob(conn: Conn, atomId: string): Promise<string> {
  const id = ulid();
  const now = new Date().toISOString();
  const ps = await conn.prepare(`
    CREATE (j:ExtractionJob {
      id: $id, atom_id: $atom, queued_at: $now,
      attempts: 0, status: 'queued', error: ''
    })
  `);
  await conn.execute(ps, { id, atom: atomId, now });
  return id;
}

// ─── Claim next ─────────────────────────────────────────────────────────────

/**
 * Pull the oldest queued job, mark it in_progress, bump attempts.
 * Returns null if the queue is empty.
 * Caller must hold the write lock.
 */
export async function claimNextJob(conn: Conn): Promise<ClaimedJob | null> {
  const findPs = await conn.prepare(`
    MATCH (j:ExtractionJob)
    WHERE j.status = 'queued'
    RETURN j.id AS id, j.atom_id AS atom_id, j.attempts AS attempts, j.queued_at AS queued_at
    ORDER BY j.queued_at ASC
    LIMIT 1
  `);
  const findResult = await conn.execute(findPs, {});
  const rows = await firstResult(findResult).getAll() as Array<{
    id: string; atom_id: string; attempts: number | bigint; queued_at: string;
  }>;
  if (rows.length === 0) return null;

  const row = rows[0]!;
  const attempts = typeof row.attempts === 'bigint' ? Number(row.attempts) : row.attempts;
  const now = new Date().toISOString();

  const claimPs = await conn.prepare(`
    MATCH (j:ExtractionJob {id: $id})
    SET j.status = 'in_progress', j.attempts = $attempts, j.queued_at = $now
  `);
  await conn.execute(claimPs, { id: row.id, attempts: attempts + 1, now });

  return {
    id: row.id,
    atom_id: row.atom_id,
    attempts: attempts + 1,
    queued_at: row.queued_at,
    status: 'in_progress',
    error: null,
  };
}

// ─── Complete ───────────────────────────────────────────────────────────────

export async function markJobDone(conn: Conn, jobId: string): Promise<void> {
  const ps = await conn.prepare(`
    MATCH (j:ExtractionJob {id: $id})
    SET j.status = 'done', j.error = ''
  `);
  await conn.execute(ps, { id: jobId });
}

export async function markJobFailed(conn: Conn, jobId: string, error: string): Promise<void> {
  const ps = await conn.prepare(`
    MATCH (j:ExtractionJob {id: $id})
    SET j.status = 'failed', j.error = $err
  `);
  await conn.execute(ps, { id: jobId, err: error.slice(0, 1000) });
}

/**
 * Put a job back in the queue for later retry. Stores the next-eligible time
 * by offsetting `queued_at` into the future; `claimNextJob` already orders by
 * queued_at ASC so a backoff is honored naturally (callers should skip jobs
 * whose queued_at > now, or rely on maintenance cleanup).
 */
export async function requeueJob(conn: Conn, jobId: string, backoffMs: number): Promise<void> {
  const nextAt = new Date(Date.now() + Math.max(0, backoffMs)).toISOString();
  const ps = await conn.prepare(`
    MATCH (j:ExtractionJob {id: $id})
    SET j.status = 'queued', j.queued_at = $next, j.error = ''
  `);
  await conn.execute(ps, { id: jobId, next: nextAt });
}

// ─── Stale reset ────────────────────────────────────────────────────────────

/**
 * Any job stuck in 'in_progress' longer than `maxAgeMs` gets reset to 'queued'.
 * Runs at worker startup (recover from a crashed worker) and periodically.
 * Returns the count of jobs reset.
 */
export async function resetStaleInProgress(conn: Conn, maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const countPs = await conn.prepare(`
    MATCH (j:ExtractionJob)
    WHERE j.status = 'in_progress' AND j.queued_at < $cutoff
    RETURN count(j) AS n
  `);
  const countResult = await conn.execute(countPs, { cutoff });
  const countRows = await firstResult(countResult).getAll() as Array<{ n: number | bigint }>;
  const n = countRows[0]?.n ?? 0;
  const count = typeof n === 'bigint' ? Number(n) : n;

  if (count > 0) {
    const now = new Date().toISOString();
    const resetPs = await conn.prepare(`
      MATCH (j:ExtractionJob)
      WHERE j.status = 'in_progress' AND j.queued_at < $cutoff
      SET j.status = 'queued', j.queued_at = $now, j.error = 'reset: stale in_progress'
    `);
    await conn.execute(resetPs, { cutoff, now });
    logger.warn({ count }, 'Reset stale in_progress jobs');
  }
  return count;
}

// ─── Inspection helpers ─────────────────────────────────────────────────────

export async function countByStatus(conn: Conn): Promise<Record<JobStatus, number>> {
  const ps = await conn.prepare(`
    MATCH (j:ExtractionJob) RETURN j.status AS status, count(j) AS n
  `);
  const result = await conn.execute(ps, {});
  const rows = await firstResult(result).getAll() as Array<{ status: JobStatus; n: number | bigint }>;

  const counts: Record<JobStatus, number> = { queued: 0, in_progress: 0, done: 0, failed: 0 };
  for (const row of rows) {
    const n = typeof row.n === 'bigint' ? Number(row.n) : row.n;
    counts[row.status] = n;
  }
  return counts;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

type KuzuQueryResult = Awaited<ReturnType<Conn['execute']>>;

function firstResult(r: KuzuQueryResult): Exclude<KuzuQueryResult, unknown[]> {
  return (Array.isArray(r) ? r[0] : r) as Exclude<KuzuQueryResult, unknown[]>;
}
