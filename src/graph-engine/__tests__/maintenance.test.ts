// Maintenance integration tests: framework + tier-recompute + alias-confirm
// (the structural mutation half — LLM judge is stubbed to keep tests offline).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphEngineInstance } from '../instance.js';
import { runMaintenance, _resetRegistryForTesting, _registerForTesting } from '../maintenance/index.js';
import {
  _collapseAliasForTesting,
  _rejectAliasForTesting,
  type _SuspectedAliasRowForTesting,
} from '../maintenance/alias-confirm.js';
import type { SchemaSpec } from '../types.js';

function spec(opts: { agingEnabled?: boolean } = {}): SchemaSpec {
  return {
    typeName: 'test',
    atomKinds: ['memory'],
    entityTypes: ['concept', 'person'],
    associationKinds: [{ name: 'ASSOCIATED', weighted: true }],
    occurrenceKinds: [{ name: 'MENTIONS', hasProminence: true }],
    episodesEnabled: true,
    agingEnabled: opts.agingEnabled ?? true,
    reconsolidationEnabled: true,
    retrievalCoActivationEnabled: true,
    writeMode: 'text',
    embeddingsEnabled: false,
    extractPrompt: () => '',
    resolverConfig: { weights: {}, acceptThreshold: 0.75, uncertainThreshold: 0.5 },
    maintenancePolicies: [],
  };
}

async function exec(conn: any, query: string, params: Record<string, unknown> = {}): Promise<void> {
  const ps = await conn.prepare(query);
  await conn.execute(ps, params);
}

async function get(conn: any, query: string, params: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> {
  const ps = await conn.prepare(query);
  const r = await conn.execute(ps, params);
  return await (Array.isArray(r) ? r[0] : r).getAll();
}

// ─── Tier recompute ─────────────────────────────────────────────────────────

describe('maintenance: tier-recompute', () => {
  let engine: GraphEngineInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'maint-tier-'));
    engine = new GraphEngineInstance({ spec: spec(), dbPath: join(tmpDir, 'kuzu') });
    await engine.initialize();
  });

  afterAll(async () => {
    try { await engine.close(); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await exec(engine.getConnection(), 'MATCH (a:Atom) DETACH DELETE a');
  });

  function seedAtom(opts: { id: string; createdDaysAgo: number; access: number }): Promise<void> {
    const created = new Date(Date.now() - opts.createdDaysAgo * 86400_000).toISOString();
    return exec(engine.getConnection(), `
      CREATE (:Atom {
        id: $id, content: 'x', kind: 'memory', salience: 'normal',
        created_at: $created, last_accessed: $created, access_count: $access,
        source_instance: 'test', cwd: null, source_kind: 'consolidate',
        tier: 'hot', extracted: false, foreign_episode: null, superseded_by: null
      })
    `, { id: opts.id, created, access: opts.access });
  }

  it('classifies atoms into hot / warm / cold by age', async () => {
    await seedAtom({ id: 'recent',  createdDaysAgo: 1,   access: 0 }); // hot
    await seedAtom({ id: 'midage',  createdDaysAgo: 30,  access: 0 }); // warm
    await seedAtom({ id: 'ancient', createdDaysAgo: 200, access: 0 }); // cold

    const report = await runMaintenance(engine, ['tier-recompute']);
    expect(report.passes[0].ok).toBe(true);

    const rows = await get(engine.getConnection(),
      'MATCH (a:Atom) RETURN a.id AS id, a.tier AS tier');
    const tiers = Object.fromEntries(rows.map((r) => [r.id, r.tier]));
    expect(tiers.recent).toBe('hot');
    expect(tiers.midage).toBe('warm');
    expect(tiers.ancient).toBe('cold');
  });

  it('access_count promotes a cold atom to warm', async () => {
    await seedAtom({ id: 'old-but-loved', createdDaysAgo: 200, access: 2 });

    await runMaintenance(engine, ['tier-recompute']);

    const rows = await get(engine.getConnection(),
      'MATCH (a:Atom {id: $id}) RETURN a.tier AS tier', { id: 'old-but-loved' });
    expect(rows[0].tier).toBe('warm');
  });

  it('access_count promotes an ancient atom all the way to hot', async () => {
    await seedAtom({ id: 'classic', createdDaysAgo: 365, access: 5 });

    await runMaintenance(engine, ['tier-recompute']);

    const rows = await get(engine.getConnection(),
      'MATCH (a:Atom {id: $id}) RETURN a.tier AS tier', { id: 'classic' });
    expect(rows[0].tier).toBe('hot');
  });

  it('returns noop when agingEnabled is false', async () => {
    const noAgingTmp = mkdtempSync(join(tmpdir(), 'maint-noaging-'));
    const noAgingEngine = new GraphEngineInstance({
      spec: spec({ agingEnabled: false }),
      dbPath: join(noAgingTmp, 'kuzu'),
    });
    await noAgingEngine.initialize();
    try {
      const report = await runMaintenance(noAgingEngine, ['tier-recompute']);
      expect(report.passes[0].ok).toBe(true);
      expect(report.passes[0].stats.noop).toBe(true);
    } finally {
      await noAgingEngine.close();
      rmSync(noAgingTmp, { recursive: true, force: true });
    }
  });

  it('records a MaintenanceRun node', async () => {
    await runMaintenance(engine, ['tier-recompute'], { trigger: 'manual' });
    const rows = await get(engine.getConnection(),
      'MATCH (r:MaintenanceRun) RETURN r.trigger AS trigger, r.stats AS stats');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const last = rows[rows.length - 1];
    expect(last.trigger).toBe('manual');
    const stats = JSON.parse(String(last.stats));
    expect(stats.passes[0].name).toBe('tier-recompute');
    expect(stats.passes[0].ok).toBe(true);
  });
});

// ─── Runner ─────────────────────────────────────────────────────────────────

describe('maintenance: runner', () => {
  let engine: GraphEngineInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'maint-runner-'));
    engine = new GraphEngineInstance({ spec: spec(), dbPath: join(tmpDir, 'kuzu') });
    await engine.initialize();
  });

  afterAll(async () => {
    _resetRegistryForTesting();
    try { await engine.close(); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('reports unknown passes without crashing', async () => {
    const report = await runMaintenance(engine, ['nope-not-real']);
    expect(report.passes[0].ok).toBe(false);
    expect(report.passes[0].error).toBe('unknown pass');
  });

  it('isolates pass failures', async () => {
    _registerForTesting({
      name: 'always-throws',
      cadence: 'nightly',
      run: async () => { throw new Error('boom'); },
    });
    const report = await runMaintenance(engine, ['always-throws', 'tier-recompute']);
    expect(report.passes[0].ok).toBe(false);
    expect(report.passes[0].error).toBe('boom');
    expect(report.passes[1].ok).toBe(true); // tier-recompute still ran
  });
});

// ─── Alias confirm (mutation half) ──────────────────────────────────────────

describe('maintenance: alias-confirm mutations', () => {
  let engine: GraphEngineInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'maint-alias-'));
    engine = new GraphEngineInstance({ spec: spec(), dbPath: join(tmpDir, 'kuzu') });
    await engine.initialize();
  });

  afterAll(async () => {
    try { await engine.close(); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    const conn = engine.getConnection();
    await exec(conn, 'MATCH (a:Atom) DETACH DELETE a');
    await exec(conn, 'MATCH (e:Entity) DETACH DELETE e');
  });

  async function seedTwoEntitiesWithAlias(): Promise<_SuspectedAliasRowForTesting> {
    const conn = engine.getConnection();
    const now = new Date().toISOString();

    await exec(conn, `CREATE (:Entity {
      id: 'e-from', name: 'Annie', type: 'person',
      first_seen: $now, last_seen: $now, mention_count: 2,
      aliases: ['Anny'], status: 'active'
    })`, { now });
    await exec(conn, `CREATE (:Entity {
      id: 'e-to', name: 'Anna', type: 'person',
      first_seen: $now, last_seen: $now, mention_count: 5,
      aliases: [], status: 'active'
    })`, { now });
    await exec(conn, `MATCH (f:Entity {id:'e-from'}), (t:Entity {id:'e-to'})
                       CREATE (f)-[:ALIAS_OF {confidence: 0.6, status: 'suspected'}]->(t)`);

    // One atom each — to test rewiring
    await exec(conn, `CREATE (:Atom {
      id: 'a1', content: 'Annie called', kind: 'memory', salience: 'normal',
      created_at: $now, last_accessed: $now, access_count: 0,
      source_instance: 'test', cwd: null, source_kind: 'consolidate',
      tier: 'hot', extracted: true, foreign_episode: null, superseded_by: null
    })`, { now });
    await exec(conn, `CREATE (:Atom {
      id: 'a2', content: 'Anna replied', kind: 'memory', salience: 'normal',
      created_at: $now, last_accessed: $now, access_count: 0,
      source_instance: 'test', cwd: null, source_kind: 'consolidate',
      tier: 'hot', extracted: true, foreign_episode: null, superseded_by: null
    })`, { now });
    await exec(conn, `MATCH (a:Atom {id:'a1'}), (e:Entity {id:'e-from'})
                       CREATE (a)-[:MENTIONS {prominence: 0.8, created_at: $now}]->(e)`, { now });
    await exec(conn, `MATCH (a:Atom {id:'a2'}), (e:Entity {id:'e-to'})
                       CREATE (a)-[:MENTIONS {prominence: 0.9, created_at: $now}]->(e)`, { now });

    return {
      fromId: 'e-from', fromName: 'Annie', fromType: 'person',
      fromMentions: 2, fromCreated: now,
      toId: 'e-to', toName: 'Anna', toType: 'person', toMentions: 5,
      confidence: 0.6,
    };
  }

  it('collapse: rewires MENTIONS, marks "from" merged, confirms edge', async () => {
    const row = await seedTwoEntitiesWithAlias();
    await _collapseAliasForTesting(engine, 'Entity', 'Atom', row);

    const conn = engine.getConnection();

    // a1 should now mention e-to, not e-from
    const a1 = await get(conn, `MATCH (a:Atom {id:'a1'})-[:MENTIONS]->(e:Entity)
                                 RETURN e.id AS id`);
    expect(a1.map((r) => r.id)).toEqual(['e-to']);

    // No MENTIONS edges should remain on e-from
    const fromMentions = await get(conn, `MATCH (:Atom)-[r:MENTIONS]->(e:Entity {id:'e-from'})
                                           RETURN count(r) AS n`);
    expect(Number(fromMentions[0].n)).toBe(0);

    // e-from is merged
    const fromStatus = await get(conn, `MATCH (e:Entity {id:'e-from'}) RETURN e.status AS status`);
    expect(fromStatus[0].status).toBe('merged');

    // e-to absorbed mention_count
    const toRow = await get(conn, `MATCH (e:Entity {id:'e-to'})
                                    RETURN e.mention_count AS mc, e.aliases AS aliases`);
    expect(Number(toRow[0].mc)).toBe(7);
    expect(toRow[0].aliases).toContain('Annie');

    // ALIAS_OF edge is now confirmed
    const edge = await get(conn, `MATCH (:Entity {id:'e-from'})-[r:ALIAS_OF]->(:Entity {id:'e-to'})
                                   RETURN r.status AS status`);
    expect(edge[0].status).toBe('confirmed');
  });

  it('reject: deletes the ALIAS_OF edge, leaves entities and atoms untouched', async () => {
    const row = await seedTwoEntitiesWithAlias();
    await _rejectAliasForTesting(engine, 'Entity', row);

    const conn = engine.getConnection();
    const edges = await get(conn, `MATCH (:Entity {id:'e-from'})-[r:ALIAS_OF]->(:Entity {id:'e-to'})
                                    RETURN count(r) AS n`);
    expect(Number(edges[0].n)).toBe(0);

    // Both entities still active
    const statuses = await get(conn, `MATCH (e:Entity) RETURN e.id AS id, e.status AS status`);
    expect(statuses.every((r) => r.status === 'active')).toBe(true);

    // Mentions untouched
    const mentions = await get(conn, `MATCH (:Atom)-[r:MENTIONS]->(:Entity)
                                       RETURN count(r) AS n`);
    expect(Number(mentions[0].n)).toBe(2);
  });
});
