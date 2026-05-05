// Regression for Bug 1: parallel callers of getEngine() for the same dbPath
// must observe a single shared initialization, never two competing ones racing
// for Kuzu's OS-level file lock.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEngine, closeEngine } from '../singleton.js';
import type { SchemaSpec } from '../types.js';

function makeSpec(): SchemaSpec {
  return {
    typeName: 'singleton-test',
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
    extractPrompt: () => 'x',
    resolverConfig: { weights: {}, acceptThreshold: 0.75, uncertainThreshold: 0.5 },
    maintenancePolicies: [],
  };
}

describe('singleton getEngine concurrency', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) {
      try { await closeEngine(join(d, 'kuzu')); } catch { /* ignore */ }
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('parallel callers for the same dbPath share one engine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'singleton-test-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'kuzu');
    const spec = makeSpec();

    // 8 concurrent callers — without serialization, each would construct its
    // own GraphEngineInstance and race for Kuzu's file lock.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => getEngine(dbPath, spec)),
    );

    // All 8 must resolve to the *same* engine instance.
    for (const e of results) {
      expect(e).toBe(results[0]);
    }
  });

  it('a second call after the first resolves still returns the cached engine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'singleton-test-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'kuzu');
    const spec = makeSpec();

    const first = await getEngine(dbPath, spec);
    const second = await getEngine(dbPath, spec);
    expect(first).toBe(second);
  });

  it('different dbPaths get separate engines', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'singleton-test-'));
    const dirB = mkdtempSync(join(tmpdir(), 'singleton-test-'));
    tmpDirs.push(dirA, dirB);
    const spec = makeSpec();

    const [a, b] = await Promise.all([
      getEngine(join(dirA, 'kuzu'), spec),
      getEngine(join(dirB, 'kuzu'), spec),
    ]);
    expect(a).not.toBe(b);
  });
});
