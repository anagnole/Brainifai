// Read-primitives integration tests — read-only, seed once.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphEngineInstance } from '../instance.js';
import { writeAtom } from '../write-path.js';
import { processOneJob, type ExtractedEntity } from '../worker.js';
import {
  fetchAtomsByOrder,
  fetchMentioningAtoms,
  fetchAtomsByEpisode,
  spreadActivation,
} from '../reads.js';
import { findActiveEpisode } from '../episode.js';
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
    resolverConfig: { weights: { name_similarity: 1 }, acceptThreshold: 0.75, uncertainThreshold: 0.5 },
    maintenancePolicies: [],
  };
}

describe('read primitives (integration, seeded once)', () => {
  let engine: GraphEngineInstance;
  let tmpDir: string;

  // Seed state shared across tests.
  const atomIds: string[] = [];
  const entityIdByName: Record<string, string> = {};
  let episodeId: string;
  let episodeIdB: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reads-test-'));
    engine = new GraphEngineInstance({ spec: makeSpec(), dbPath: join(tmpDir, 'kuzu') });
    await engine.initialize();

    // Seed: 3 atoms in /tmp/a mentioning (Brainifai, Kuzu), (Brainifai, MCP), (Kuzu, Anna)
    // 1 atom in /tmp/b mentioning (Anna, Brainifai)
    const ctx = (cwd: string) => ({ source_instance: 'test', cwd });

    const a1 = await writeAtom(engine, { content: 'first', kind: 'memory', context: ctx('/tmp/a') });
    atomIds.push(a1.id);
    await new Promise((r) => setTimeout(r, 5));

    const a2 = await writeAtom(engine, { content: 'second', kind: 'memory', context: ctx('/tmp/a') });
    atomIds.push(a2.id);
    await new Promise((r) => setTimeout(r, 5));

    const a3 = await writeAtom(engine, { content: 'third', kind: 'memory', context: ctx('/tmp/a') });
    atomIds.push(a3.id);
    await new Promise((r) => setTimeout(r, 5));

    const a4 = await writeAtom(engine, { content: 'fourth', kind: 'decision', context: ctx('/tmp/b') });
    atomIds.push(a4.id);

    // Run the worker for each with a fixed extractor
    const extractors: Record<string, ExtractedEntity[]> = {
      [a1.id]: [
        { name: 'Brainifai', type: 'concept', prominence: 0.9 },
        { name: 'Kuzu',      type: 'concept', prominence: 0.7 },
      ],
      [a2.id]: [
        { name: 'Brainifai', type: 'concept', prominence: 0.9 },
        { name: 'MCP',       type: 'concept', prominence: 0.8 },
      ],
      [a3.id]: [
        { name: 'Kuzu', type: 'concept', prominence: 0.8 },
        { name: 'Anna', type: 'concept', prominence: 0.6 },
      ],
      [a4.id]: [
        { name: 'Anna',      type: 'concept', prominence: 0.7 },
        { name: 'Brainifai', type: 'concept', prominence: 0.9 },
      ],
    };

    for (let i = 0; i < 4; i++) {
      // Each processOneJob claims one job; the queue is FIFO so the next job
      // corresponds to the next atom in enqueue order.
      const nextAtomId = atomIds[i]!;
      await processOneJob(engine, {
        extract: async () => extractors[nextAtomId]!,
      });
    }

    // Grab entity ids for later assertions
    const conn = engine.getConnection();
    const raw = await conn.query(`MATCH (e:Entity) RETURN e.id AS id, e.name AS name`);
    const entityRows = await (Array.isArray(raw) ? raw[0]! : raw).getAll() as Array<{ id: string; name: string }>;
    for (const r of entityRows) entityIdByName[r.name] = r.id;

    // Grab episode ids
    const epA = await findActiveEpisode(conn, 'test', '/tmp/a');
    const epB = await findActiveEpisode(conn, 'test', '/tmp/b');
    episodeId = epA!;
    episodeIdB = epB!;
  });

  afterAll(async () => {
    try { await engine.close(); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('fetchAtomsByOrder: returns atoms ordered by last_accessed desc', async () => {
    const result = await fetchAtomsByOrder(engine, {
      orderBy: 'last_accessed', direction: 'desc', limit: 10,
    });
    expect(result.length).toBe(4);
    // Most-recent first; the 4th atom was last written so it should lead.
    expect(result[0]!.id).toBe(atomIds[3]);
  });

  it('fetchAtomsByOrder: filters by cwd', async () => {
    const result = await fetchAtomsByOrder(engine, {
      orderBy: 'created_at', limit: 10, filter: { cwd: '/tmp/b' },
    });
    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe(atomIds[3]);
  });

  it('fetchAtomsByOrder: filters by kind', async () => {
    const result = await fetchAtomsByOrder(engine, {
      orderBy: 'created_at', limit: 10, filter: { kind: 'decision' },
    });
    expect(result.length).toBe(1);
    expect(result[0]!.kind).toBe('decision');
  });

  it('fetchMentioningAtoms: returns atoms that mention Brainifai', async () => {
    const result = await fetchMentioningAtoms(engine, {
      entityIds: [entityIdByName['Brainifai']!],
      limit: 10,
    });
    // 3 atoms mention Brainifai (a1, a2, a4)
    expect(result.length).toBe(3);
    for (const a of result) expect(a.mention_score).toBeGreaterThan(0);
  });

  it('fetchMentioningAtoms: scores higher for atoms with multiple matching entities', async () => {
    const result = await fetchMentioningAtoms(engine, {
      entityIds: [entityIdByName['Brainifai']!, entityIdByName['Kuzu']!],
      limit: 10,
    });
    // Atom 1 has BOTH Brainifai + Kuzu → score 0.9 + 0.7 = 1.6 (highest)
    // Atom 2 has only Brainifai → score 0.9
    // Atom 3 has only Kuzu → score 0.8
    expect(result[0]!.id).toBe(atomIds[0]);
    expect(result[0]!.matched_entities).toBe(2);
  });

  it('fetchAtomsByEpisode: returns only atoms in the given episode', async () => {
    const result = await fetchAtomsByEpisode(engine, {
      episodeIds: [episodeIdB], limit: 10,
    });
    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe(atomIds[3]);
  });

  it('fetchAtomsByEpisode: filters by kind', async () => {
    const result = await fetchAtomsByEpisode(engine, {
      episodeIds: [episodeId, episodeIdB], limit: 10, kind: 'memory',
    });
    // Only a1, a2, a3 are kind='memory'; a4 is 'decision'
    expect(result.length).toBe(3);
    for (const a of result) expect(a.kind).toBe('memory');
  });

  it('spreadActivation: hop-1 activation reaches direct neighbors', async () => {
    const result = await spreadActivation(engine, {
      seeds: [{ entityId: entityIdByName['Brainifai']!, score: 1.0 }],
      hops: 1,
    });
    // Brainifai is connected to Kuzu, MCP, Anna (via the 4 atoms).
    // All 4 entities should appear.
    const ids = new Set(result.map((r) => r.entityId));
    expect(ids.has(entityIdByName['Brainifai'])).toBe(true);
    expect(ids.has(entityIdByName['Kuzu'])).toBe(true);
    expect(ids.has(entityIdByName['MCP'])).toBe(true);
    expect(ids.has(entityIdByName['Anna'])).toBe(true);
  });

  it('spreadActivation: seed has highest score', async () => {
    const result = await spreadActivation(engine, {
      seeds: [{ entityId: entityIdByName['Brainifai']!, score: 1.0 }],
      hops: 2,
    });
    expect(result[0]!.entityId).toBe(entityIdByName['Brainifai']);
    expect(result[0]!.score).toBe(1.0);
  });

  it('spreadActivation: hop-2 can reach further entities via chained associations', async () => {
    // Seed: just a single entity, hops=2
    const result = await spreadActivation(engine, {
      seeds: [{ entityId: entityIdByName['MCP']!, score: 1.0 }],
      hops: 2,
      decay: 0.7,
    });
    // MCP connects to Brainifai. Brainifai connects to Kuzu, Anna.
    // All four should appear via 2-hop spread.
    const ids = new Set(result.map((r) => r.entityId));
    expect(ids.has(entityIdByName['Brainifai'])).toBe(true);
    expect(ids.has(entityIdByName['Kuzu'])).toBe(true); // 2-hop from MCP
    expect(ids.has(entityIdByName['Anna'])).toBe(true); // 2-hop from MCP
  });

  it('spreadActivation: empty seeds returns empty', async () => {
    const result = await spreadActivation(engine, { seeds: [], hops: 1 });
    expect(result).toEqual([]);
  });
});
