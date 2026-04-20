// Integration tests for writeAtom + writeAtoms against a real Kuzu DB.
// Shares one engine across tests per our Kuzu teardown policy.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphEngineInstance } from '../instance.js';
import { writeAtom, writeAtoms } from '../write-path.js';
import { countByStatus } from '../queue.js';
import { findActiveEpisode, startEpisode, closeEpisode } from '../episode.js';
import type { SchemaSpec } from '../types.js';

function makeSpec(overrides: Partial<SchemaSpec> = {}): SchemaSpec {
  return {
    typeName: 'test',
    atomKinds: ['memory'],
    entityTypes: ['concept'],
    associationKinds: [{ name: 'ASSOCIATED', weighted: true }],
    occurrenceKinds: [{ name: 'MENTIONS', hasProminence: true }],
    episodesEnabled: true,
    agingEnabled: true,
    reconsolidationEnabled: true,
    retrievalCoActivationEnabled: true,
    writeMode: 'text',
    embeddingsEnabled: false,
    extractPrompt: () => '',
    resolverConfig: { weights: {}, acceptThreshold: 0.75, uncertainThreshold: 0.5 },
    maintenancePolicies: [],
    ...overrides,
  };
}

async function getAll<T = Record<string, unknown>>(conn: any, cypher: string, params: any = {}): Promise<T[]> {
  if (Object.keys(params).length > 0) {
    const ps = await conn.prepare(cypher);
    const result = await conn.execute(ps, params);
    return (Array.isArray(result) ? result[0] : result).getAll();
  }
  const result = await conn.query(cypher);
  return (Array.isArray(result) ? result[0] : result).getAll();
}

describe('writeAtom (integration)', () => {
  let engine: GraphEngineInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'write-path-test-'));
    engine = new GraphEngineInstance({ spec: makeSpec(), dbPath: join(tmpDir, 'kuzu') });
    await engine.initialize();
  });

  afterAll(async () => {
    try { await engine.close(); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    const conn = engine.getConnection();
    // Clear between tests
    await conn.query('MATCH (a:Atom) DETACH DELETE a');
    await conn.query('MATCH (e:Episode) DETACH DELETE e');
    await conn.query('MATCH (j:ExtractionJob) DELETE j');
  });

  it('creates an Atom with expected fields', async () => {
    const { id } = await writeAtom(engine, {
      content: 'hello world',
      kind: 'decision',
      salience: 'high',
      context: { source_instance: 'test', cwd: '/tmp/a' },
    });

    const rows = await getAll(engine.getConnection(), `
      MATCH (a:Atom {id: $id})
      RETURN a.content AS content, a.kind AS kind, a.salience AS salience,
             a.source_instance AS si, a.cwd AS cwd, a.source_kind AS sk,
             a.extracted AS extracted, a.tier AS tier
    `, { id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      content: 'hello world',
      kind: 'decision',
      salience: 'high',
      si: 'test',
      cwd: '/tmp/a',
      sk: 'consolidate',
      extracted: false,
      tier: 'hot',
    });
  });

  it('enqueues an ExtractionJob', async () => {
    await writeAtom(engine, {
      content: 'x',
      kind: 'memory',
      context: { source_instance: 'test', cwd: null },
    });
    const counts = await countByStatus(engine.getConnection());
    expect(counts.queued).toBe(1);
  });

  it('auto-creates an Episode and links IN_EPISODE on first write', async () => {
    const { id } = await writeAtom(engine, {
      content: 'first atom',
      kind: 'memory',
      context: { source_instance: 'test', cwd: '/tmp/ep-1' },
    });

    const rows = await getAll(engine.getConnection(), `
      MATCH (a:Atom {id: $id})-[:IN_EPISODE]->(e:Episode)
      RETURN e.id AS eid, e.source_instance AS si, e.cwd AS cwd, e.closed AS closed
    `, { id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ si: 'test', cwd: '/tmp/ep-1', closed: false });
  });

  it('reuses the active Episode across writes in the same context', async () => {
    const ctx = { source_instance: 'test', cwd: '/tmp/reuse' };
    const r1 = await writeAtom(engine, { content: 'one', kind: 'memory', context: ctx });
    const r2 = await writeAtom(engine, { content: 'two', kind: 'memory', context: ctx });

    const rows = await getAll(engine.getConnection(), `
      MATCH (a:Atom)-[:IN_EPISODE]->(e:Episode)
      WHERE a.id IN [$a, $b]
      RETURN a.id AS aid, e.id AS eid
    `, { a: r1.id, b: r2.id });

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r: any) => r.eid)).size).toBe(1);
  });

  it('opens a separate Episode for a different cwd', async () => {
    const r1 = await writeAtom(engine, {
      content: 'one', kind: 'memory',
      context: { source_instance: 'test', cwd: '/tmp/a' },
    });
    const r2 = await writeAtom(engine, {
      content: 'two', kind: 'memory',
      context: { source_instance: 'test', cwd: '/tmp/b' },
    });

    const rows = await getAll(engine.getConnection(), `
      MATCH (a:Atom)-[:IN_EPISODE]->(e:Episode)
      WHERE a.id IN [$a, $b]
      RETURN a.id AS aid, e.id AS eid
    `, { a: r1.id, b: r2.id });

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r: any) => r.eid)).size).toBe(2);
  });

  it('does not re-attach an atom to a closed Episode', async () => {
    const ctx = { source_instance: 'test', cwd: '/tmp/closed' };
    const conn = engine.getConnection();

    const epId = await startEpisode(conn, ctx);
    await closeEpisode(conn, epId);

    // findActiveEpisode should return null now
    expect(await findActiveEpisode(conn, 'test', '/tmp/closed')).toBeNull();

    // Next write creates a fresh episode
    const r = await writeAtom(engine, { content: 'new', kind: 'memory', context: ctx });
    const rows = await getAll(conn, `
      MATCH (a:Atom {id: $id})-[:IN_EPISODE]->(e:Episode)
      RETURN e.id AS eid
    `, { id: r.id });
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).eid).not.toBe(epId);
  });

  it('skips Episode linkage when context.foreign_episode is set', async () => {
    const { id } = await writeAtom(engine, {
      content: 'cross-instance',
      kind: 'session-summary',
      context: {
        source_instance: 'general',
        cwd: '/tmp/x',
        foreign_episode: { instance: 'coding', episode_id: 'coding-ep-123' },
      },
    });

    const atoms = await getAll(engine.getConnection(), `
      MATCH (a:Atom {id: $id}) RETURN a.foreign_episode AS fe
    `, { id });
    expect((atoms[0] as any).fe).toBe(JSON.stringify({ instance: 'coding', episode_id: 'coding-ep-123' }));

    const links = await getAll(engine.getConnection(), `
      MATCH (a:Atom {id: $id})-[:IN_EPISODE]->(e) RETURN e.id AS eid
    `, { id });
    expect(links).toHaveLength(0);
  });

  it('creates SUPERSEDES edge and sets superseded_by on prior atom', async () => {
    const ctx = { source_instance: 'test', cwd: '/tmp/sup' };
    const original = await writeAtom(engine, { content: 'original fact', kind: 'decision', context: ctx });
    const correction = await writeAtom(engine, {
      content: 'corrected fact',
      kind: 'correction',
      context: ctx,
      supersedes: original.id,
    });

    const edges = await getAll(engine.getConnection(), `
      MATCH (n:Atom {id: $n})-[:SUPERSEDES]->(p:Atom {id: $p})
      RETURN count(*) AS c
    `, { n: correction.id, p: original.id });
    expect(Number((edges[0] as any).c)).toBe(1);

    const priorStatus = await getAll(engine.getConnection(), `
      MATCH (a:Atom {id: $id}) RETURN a.superseded_by AS sb
    `, { id: original.id });
    expect((priorStatus[0] as any).sb).toBe(correction.id);

    expect(correction.superseded).toEqual([original.id]);
  });

  it('supports multiple supersedes ids', async () => {
    const ctx = { source_instance: 'test', cwd: '/tmp/sup2' };
    const a = await writeAtom(engine, { content: 'A', kind: 'decision', context: ctx });
    const b = await writeAtom(engine, { content: 'B', kind: 'decision', context: ctx });
    const c = await writeAtom(engine, {
      content: 'C', kind: 'correction', context: ctx,
      supersedes: [a.id, b.id],
    });
    expect(c.superseded).toEqual([a.id, b.id]);

    const edges = await getAll(engine.getConnection(), `
      MATCH (n:Atom {id: $n})-[:SUPERSEDES]->(p:Atom)
      RETURN count(p) AS c
    `, { n: c.id });
    expect(Number((edges[0] as any).c)).toBe(2);
  });

  it('writeAtoms batch-writes multiple atoms + enqueues N jobs', async () => {
    const ctx = { source_instance: 'test', cwd: '/tmp/batch' };
    const results = await writeAtoms(engine, [
      { content: 'a1', kind: 'memory', context: ctx },
      { content: 'a2', kind: 'memory', context: ctx },
      { content: 'a3', kind: 'memory', context: ctx },
    ]);
    expect(results).toHaveLength(3);

    const atomCount = await getAll(engine.getConnection(), `MATCH (a:Atom) RETURN count(a) AS c`);
    expect(Number((atomCount[0] as any).c)).toBe(3);

    const counts = await countByStatus(engine.getConnection());
    expect(counts.queued).toBe(3);
  });

  it('ignores episodesEnabled=false (no Episode created)', async () => {
    // Use a separate engine with episodes disabled
    const altDir = mkdtempSync(join(tmpdir(), 'write-path-no-ep-'));
    const alt = new GraphEngineInstance({
      spec: makeSpec({ episodesEnabled: false }),
      dbPath: join(altDir, 'kuzu'),
    });
    try {
      await alt.initialize();
      const { id } = await writeAtom(alt, {
        content: 'x', kind: 'memory',
        context: { source_instance: 'test', cwd: '/tmp/no-ep' },
      });
      // Should succeed; Episode table doesn't even exist
      const rows = await getAll(alt.getConnection(), `MATCH (a:Atom {id: $id}) RETURN a.id AS id`, { id });
      expect(rows).toHaveLength(1);
    } finally {
      await alt.close();
      rmSync(altDir, { recursive: true, force: true });
    }
  });
});
