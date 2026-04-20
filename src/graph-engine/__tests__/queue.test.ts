// Queue integration tests against a real Kuzu DB. Shares one engine across
// tests + clears jobs between them — Kuzu's native teardown has a known
// segfault pattern when cycled repeatedly in a single process.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphEngineInstance } from '../instance.js';
import {
  enqueueJob, claimNextJob, markJobDone, markJobFailed, requeueJob,
  resetStaleInProgress, countByStatus,
} from '../queue.js';
import type { SchemaSpec } from '../types.js';

function makeSpec(): SchemaSpec {
  return {
    typeName: 'test',
    atomKinds: ['memory'],
    entityTypes: ['concept'],
    associationKinds: [{ name: 'ASSOCIATED', weighted: true }],
    occurrenceKinds: [{ name: 'MENTIONS', hasProminence: true }],
    episodesEnabled: true,
    agingEnabled: false,
    reconsolidationEnabled: true,
    retrievalCoActivationEnabled: true,
    writeMode: 'text',
    embeddingsEnabled: false,
    extractPrompt: () => '',
    resolverConfig: { weights: {}, acceptThreshold: 0.75, uncertainThreshold: 0.5 },
    maintenancePolicies: [],
  };
}

describe('queue (integration with real Kuzu)', () => {
  let engine: GraphEngineInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
    engine = new GraphEngineInstance({ spec: makeSpec(), dbPath: join(tmpDir, 'kuzu') });
    await engine.initialize();
  });

  afterAll(async () => {
    try { await engine.close(); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    // Clear all jobs between tests
    const conn = engine.getConnection();
    await conn.query('MATCH (j:ExtractionJob) DELETE j');
  });

  it('enqueue → claim returns the job', async () => {
    const conn = engine.getConnection();
    const jobId = await enqueueJob(conn, 'atom-1');
    const claimed = await claimNextJob(conn);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(jobId);
    expect(claimed!.atom_id).toBe('atom-1');
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.status).toBe('in_progress');
  });

  it('claim on empty queue returns null', async () => {
    const claimed = await claimNextJob(engine.getConnection());
    expect(claimed).toBeNull();
  });

  it('claim is FIFO by queued_at', async () => {
    const conn = engine.getConnection();
    const firstId = await enqueueJob(conn, 'atom-1');
    await new Promise((r) => setTimeout(r, 10));
    const secondId = await enqueueJob(conn, 'atom-2');

    const first = await claimNextJob(conn);
    expect(first!.id).toBe(firstId);
    const second = await claimNextJob(conn);
    expect(second!.id).toBe(secondId);
  });

  it('markJobDone updates status', async () => {
    const conn = engine.getConnection();
    const jobId = await enqueueJob(conn, 'atom-1');
    await claimNextJob(conn);
    await markJobDone(conn, jobId);
    const counts = await countByStatus(conn);
    expect(counts.done).toBe(1);
    expect(counts.in_progress).toBe(0);
  });

  it('markJobFailed sets status and stores error', async () => {
    const conn = engine.getConnection();
    const jobId = await enqueueJob(conn, 'atom-1');
    await claimNextJob(conn);
    await markJobFailed(conn, jobId, 'LLM unavailable');
    const counts = await countByStatus(conn);
    expect(counts.failed).toBe(1);
  });

  it('requeueJob resets status + schedules future queued_at', async () => {
    const conn = engine.getConnection();
    const jobId = await enqueueJob(conn, 'atom-1');
    await claimNextJob(conn);
    await requeueJob(conn, jobId, 500);
    const counts = await countByStatus(conn);
    expect(counts.queued).toBe(1);
    expect(counts.in_progress).toBe(0);
  });

  it('resetStaleInProgress resets old in_progress jobs only', async () => {
    const conn = engine.getConnection();
    await enqueueJob(conn, 'atom-1');
    const claimed = await claimNextJob(conn);
    expect(claimed).not.toBeNull();

    // Pretend the in_progress is ancient: backdate queued_at
    const backdatePs = await conn.prepare(`
      MATCH (j:ExtractionJob {id: $id}) SET j.queued_at = $old_ts
    `);
    await conn.execute(backdatePs, {
      id: claimed!.id,
      old_ts: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    const reset = await resetStaleInProgress(conn, 5 * 60_000);
    expect(reset).toBe(1);

    const counts = await countByStatus(conn);
    expect(counts.queued).toBe(1);
    expect(counts.in_progress).toBe(0);
  });

  it('resetStaleInProgress leaves fresh in_progress alone', async () => {
    const conn = engine.getConnection();
    await enqueueJob(conn, 'atom-1');
    await claimNextJob(conn);
    const reset = await resetStaleInProgress(conn, 5 * 60_000);
    expect(reset).toBe(0);
    const counts = await countByStatus(conn);
    expect(counts.in_progress).toBe(1);
  });
});
