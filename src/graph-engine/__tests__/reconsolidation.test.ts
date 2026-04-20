// Reconsolidation integration tests — bump last_accessed / access_count / tier
// and reinforce CO_OCCURS between retrieved atoms' entities.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphEngineInstance } from '../instance.js';
import { writeAtom } from '../write-path.js';
import { processOneJob, type ExtractedEntity } from '../worker.js';
import { bumpReconsolidation, reinforceCoOccurrence } from '../reconsolidation.js';
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
    resolverConfig: { weights: { name_similarity: 1 }, acceptThreshold: 0.75, uncertainThreshold: 0.5 },
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

describe('reconsolidation', () => {
  let engine: GraphEngineInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reconsolidation-test-'));
    engine = new GraphEngineInstance({ spec: makeSpec(), dbPath: join(tmpDir, 'kuzu') });
    await engine.initialize();
  });

  afterAll(async () => {
    try { await engine.close(); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    const conn = engine.getConnection();
    await conn.query('MATCH (a:Atom) DETACH DELETE a');
    await conn.query('MATCH (e:Entity) DETACH DELETE e');
    await conn.query('MATCH (ep:Episode) DETACH DELETE ep');
    await conn.query('MATCH (j:ExtractionJob) DELETE j');
  });

  it('bumps access_count and last_accessed', async () => {
    const { id } = await writeAtom(engine, {
      content: 'bump me', kind: 'memory',
      context: { source_instance: 'test', cwd: '/tmp/a' },
    });

    const before = await getAll(engine.getConnection(), `
      MATCH (a:Atom {id: $id}) RETURN a.access_count AS c, a.last_accessed AS la
    `, { id });

    await new Promise((r) => setTimeout(r, 5));
    await bumpReconsolidation(engine, [id]);

    const after = await getAll(engine.getConnection(), `
      MATCH (a:Atom {id: $id}) RETURN a.access_count AS c, a.last_accessed AS la
    `, { id });

    expect(Number((after[0] as any).c)).toBe(Number((before[0] as any).c) + 1);
    expect((after[0] as any).la).not.toBe((before[0] as any).la);
  });

  it('bumps multiple atoms in one call', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { id } = await writeAtom(engine, {
        content: `a-${i}`, kind: 'memory',
        context: { source_instance: 'test', cwd: '/tmp/a' },
      });
      ids.push(id);
    }
    await bumpReconsolidation(engine, ids);

    const counts = await getAll(engine.getConnection(), `
      MATCH (a:Atom) WHERE a.id IN $ids
      RETURN a.id AS id, a.access_count AS c
    `, { ids });
    expect(counts).toHaveLength(3);
    for (const row of counts) expect(Number((row as any).c)).toBe(1);
  });

  it('promotes tier cold → warm at weight ≥ 0.3', async () => {
    const { id } = await writeAtom(engine, {
      content: 'tier test', kind: 'memory',
      context: { source_instance: 'test', cwd: '/tmp/a' },
    });
    // Force tier to 'cold'
    await engine.getConnection().query(`MATCH (a:Atom {id: '${id}'}) SET a.tier = 'cold'`);

    await bumpReconsolidation(engine, [id], { weight: 0.3 });

    const rows = await getAll(engine.getConnection(), `
      MATCH (a:Atom {id: $id}) RETURN a.tier AS tier
    `, { id });
    expect((rows[0] as any).tier).toBe('warm');
  });

  it('promotes tier warm → hot at weight ≥ 0.5', async () => {
    const { id } = await writeAtom(engine, {
      content: 'tier test', kind: 'memory',
      context: { source_instance: 'test', cwd: '/tmp/a' },
    });
    await engine.getConnection().query(`MATCH (a:Atom {id: '${id}'}) SET a.tier = 'warm'`);

    await bumpReconsolidation(engine, [id], { weight: 0.5 });

    const rows = await getAll(engine.getConnection(), `
      MATCH (a:Atom {id: $id}) RETURN a.tier AS tier
    `, { id });
    expect((rows[0] as any).tier).toBe('hot');
  });

  it('noTierPromote keeps tier unchanged', async () => {
    const { id } = await writeAtom(engine, {
      content: 'tier test', kind: 'memory',
      context: { source_instance: 'test', cwd: '/tmp/a' },
    });
    await engine.getConnection().query(`MATCH (a:Atom {id: '${id}'}) SET a.tier = 'cold'`);
    await bumpReconsolidation(engine, [id], { weight: 1.0, noTierPromote: true });
    const rows = await getAll(engine.getConnection(), `MATCH (a:Atom {id: $id}) RETURN a.tier AS tier`, { id });
    expect((rows[0] as any).tier).toBe('cold');
  });

  it('reinforceCoOccurrence bumps ASSOCIATED weight for pairs', async () => {
    const { id: atomId } = await writeAtom(engine, {
      content: 'two things', kind: 'memory',
      context: { source_instance: 'test', cwd: '/tmp/a' },
    });

    const extract = async (): Promise<ExtractedEntity[]> => [
      { name: 'Alpha', type: 'concept', prominence: 0.8 },
      { name: 'Beta', type: 'concept', prominence: 0.8 },
    ];
    await processOneJob(engine, { extract });

    // Initial weight = 1 after the worker ran
    const before = await getAll(engine.getConnection(), `
      MATCH (:Entity)-[r:ASSOCIATED]->(:Entity) RETURN r.weight AS w
    `);
    expect(Number((before[0] as any).w)).toBe(1);

    // Reinforce via retrieval
    await reinforceCoOccurrence(engine, [atomId]);

    const after = await getAll(engine.getConnection(), `
      MATCH (:Entity)-[r:ASSOCIATED]->(:Entity) RETURN r.weight AS w
    `);
    expect(Number((after[0] as any).w)).toBe(2);
  });

  it('reinforceCoOccurrence is a no-op when retrievalCoActivationEnabled=false', async () => {
    // Separate engine with flag off
    const altDir = mkdtempSync(join(tmpdir(), 'reco-off-'));
    const alt = new GraphEngineInstance({
      spec: makeSpec({ retrievalCoActivationEnabled: false }),
      dbPath: join(altDir, 'kuzu'),
    });
    try {
      await alt.initialize();
      const { id: atomId } = await writeAtom(alt, {
        content: 'no reco', kind: 'memory',
        context: { source_instance: 'test', cwd: '/tmp/a' },
      });
      const extract = async (): Promise<ExtractedEntity[]> => [
        { name: 'X', type: 'concept' },
        { name: 'Y', type: 'concept' },
      ];
      await processOneJob(alt, { extract });
      await reinforceCoOccurrence(alt, [atomId]);

      const rows = await getAll(alt.getConnection(), `
        MATCH (:Entity)-[r:ASSOCIATED]->(:Entity) RETURN r.weight AS w
      `);
      expect(Number((rows[0] as any).w)).toBe(1);
    } finally {
      await alt.close();
      rmSync(altDir, { recursive: true, force: true });
    }
  });
});
