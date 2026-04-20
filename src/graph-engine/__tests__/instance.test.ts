// Integration test: boots a real Kuzu DB in a temp dir, runs initialize(),
// verifies the DDL we generate is actually accepted by Kuzu.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphEngineInstance } from '../instance.js';
import type { SchemaSpec } from '../types.js';

function makeSpec(overrides: Partial<SchemaSpec> = {}): SchemaSpec {
  return {
    typeName: 'test-general',
    atomKinds: ['memory'],
    entityTypes: ['person', 'concept', 'project'],
    associationKinds: [
      { name: 'ASSOCIATED', weighted: true },
    ],
    occurrenceKinds: [
      { name: 'MENTIONS', hasProminence: true },
    ],
    episodesEnabled: true,
    agingEnabled: true,
    reconsolidationEnabled: true,
    retrievalCoActivationEnabled: true,
    writeMode: 'text',
    embeddingsEnabled: false,
    extractPrompt: () => 'extract prompt',
    resolverConfig: { weights: {}, acceptThreshold: 0.75, uncertainThreshold: 0.5 },
    maintenancePolicies: [],
    ...overrides,
  };
}

describe('GraphEngineInstance (integration, real Kuzu)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function mkDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'graph-engine-test-'));
    tmpDirs.push(dir);
    return join(dir, 'kuzu');
  }

  it('initializes a fresh DB with a general-like spec and creates expected tables', async () => {
    const engine = new GraphEngineInstance({ spec: makeSpec(), dbPath: mkDbPath() });
    try {
      await engine.initialize();

      const conn = engine.getConnection();
      const result = await conn.query('CALL SHOW_TABLES() RETURN name, type');
      const rows = await (Array.isArray(result) ? result[0] : result).getAll();
      const tables = new Set(rows.map((r: any) => r.name));

      expect(tables.has('Atom')).toBe(true);
      expect(tables.has('Entity')).toBe(true);
      expect(tables.has('Episode')).toBe(true);
      expect(tables.has('ExtractionJob')).toBe(true);
      expect(tables.has('MaintenanceRun')).toBe(true);
      expect(tables.has('MENTIONS')).toBe(true);
      expect(tables.has('ASSOCIATED')).toBe(true);
      expect(tables.has('IN_EPISODE')).toBe(true);
      expect(tables.has('SUPERSEDES')).toBe(true);
      expect(tables.has('ALIAS_OF')).toBe(true);
    } finally {
      await engine.close();
    }
  });

  it('is idempotent — calling initialize twice on the same DB is safe', async () => {
    const dbPath = mkDbPath();
    const first = new GraphEngineInstance({ spec: makeSpec(), dbPath });
    await first.initialize();
    await first.close();

    const second = new GraphEngineInstance({ spec: makeSpec(), dbPath });
    await expect(second.initialize()).resolves.not.toThrow();
    await second.close();
  });

  it('writes and reads a single Atom node end-to-end', async () => {
    const engine = new GraphEngineInstance({ spec: makeSpec(), dbPath: mkDbPath() });
    try {
      await engine.initialize();
      const conn = engine.getConnection();

      const insert = await conn.prepare(`
        CREATE (a:Atom {
          id: $id, content: $content, kind: $kind, salience: $salience,
          created_at: $now, last_accessed: $now, access_count: 0,
          source_instance: $src, cwd: $cwd, source_kind: 'consolidate',
          extracted: false, superseded_by: '', foreign_episode: ''
        })`);
      await conn.execute(insert, {
        id: 'atom-1',
        content: 'hello world',
        kind: 'memory',
        salience: 'normal',
        now: new Date().toISOString(),
        src: 'test',
        cwd: '/tmp',
      });

      const read = await conn.query(`MATCH (a:Atom) RETURN a.id AS id, a.content AS content`);
      const rows = await (Array.isArray(read) ? read[0] : read).getAll();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 'atom-1', content: 'hello world' });
    } finally {
      await engine.close();
    }
  });

  it('emits embedding column when embeddings enabled', async () => {
    const engine = new GraphEngineInstance({
      spec: makeSpec({ embeddingsEnabled: true, embeddingDim: 8 }),
      dbPath: mkDbPath(),
    });
    try {
      await engine.initialize();
      const conn = engine.getConnection();

      // Inspect the Atom table — the insert below will fail if the embedding column doesn't exist.
      const ps = await conn.prepare(`
        CREATE (a:Atom {
          id: $id, content: $c, kind: 'memory', salience: 'normal',
          created_at: $now, last_accessed: $now, access_count: 0,
          source_instance: 'x', cwd: '/tmp', source_kind: 'consolidate',
          extracted: false, superseded_by: '', foreign_episode: '',
          embedding: $emb
        })`);
      await conn.execute(ps, {
        id: 'a-emb',
        c: 'with embedding',
        now: new Date().toISOString(),
        emb: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      });

      const r = await conn.query(`MATCH (a:Atom {id: 'a-emb'}) RETURN a.embedding AS e`);
      const rows = await (Array.isArray(r) ? r[0] : r).getAll();
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).e).toHaveLength(8);
    } finally {
      await engine.close();
    }
  });

  it('skips Episode + IN_EPISODE when episodesEnabled is false', async () => {
    const engine = new GraphEngineInstance({
      spec: makeSpec({ episodesEnabled: false }),
      dbPath: mkDbPath(),
    });
    try {
      await engine.initialize();
      const conn = engine.getConnection();
      const r = await conn.query('CALL SHOW_TABLES() RETURN name');
      const rows = await (Array.isArray(r) ? r[0] : r).getAll();
      const tables = new Set(rows.map((row: any) => row.name));
      expect(tables.has('Episode')).toBe(false);
      expect(tables.has('IN_EPISODE')).toBe(false);
      expect(tables.has('Atom')).toBe(true); // other tables still created
    } finally {
      await engine.close();
    }
  });
});
