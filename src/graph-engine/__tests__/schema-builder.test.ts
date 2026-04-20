import { describe, it, expect } from 'vitest';
import { buildDdl } from '../schema-builder.js';
import type { SchemaSpec } from '../types.js';

function minimalSpec(overrides: Partial<SchemaSpec> = {}): SchemaSpec {
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
    extractPrompt: () => 'prompt',
    resolverConfig: { weights: {}, acceptThreshold: 0.75, uncertainThreshold: 0.5 },
    maintenancePolicies: [],
    ...overrides,
  };
}

describe('buildDdl', () => {
  it('emits Atom, Entity, Episode, ExtractionJob, MaintenanceRun node tables', () => {
    const ddl = buildDdl(minimalSpec());
    const joined = ddl.nodeTables.join('\n');
    expect(joined).toMatch(/CREATE NODE TABLE IF NOT EXISTS Atom/);
    expect(joined).toMatch(/CREATE NODE TABLE IF NOT EXISTS Entity/);
    expect(joined).toMatch(/CREATE NODE TABLE IF NOT EXISTS Episode/);
    expect(joined).toMatch(/CREATE NODE TABLE IF NOT EXISTS ExtractionJob/);
    expect(joined).toMatch(/CREATE NODE TABLE IF NOT EXISTS MaintenanceRun/);
  });

  it('omits Episode table when episodesEnabled is false', () => {
    const ddl = buildDdl(minimalSpec({ episodesEnabled: false }));
    const joined = ddl.nodeTables.join('\n');
    expect(joined).not.toMatch(/Episode/);
  });

  it('tier column is present regardless of agingEnabled (agingEnabled gates promotion, not existence)', () => {
    const withAging = buildDdl(minimalSpec({ agingEnabled: true }));
    const withoutAging = buildDdl(minimalSpec({ agingEnabled: false }));
    expect(withAging.nodeTables.join('\n')).toMatch(/tier STRING/);
    expect(withoutAging.nodeTables.join('\n')).toMatch(/tier STRING/);
  });

  it('adds embedding column when embeddingsEnabled', () => {
    const ddl = buildDdl(minimalSpec({ embeddingsEnabled: true, embeddingDim: 768 }));
    expect(ddl.nodeTables.some((s) => /embedding FLOAT\[768\]/.test(s))).toBe(true);
  });

  it('emits rel tables for occurrences and associations', () => {
    const ddl = buildDdl(minimalSpec({
      occurrenceKinds: [{ name: 'MENTIONS', hasProminence: true }],
      associationKinds: [
        { name: 'ASSOCIATED', weighted: true },
        { name: 'IS_FRIEND_OF', weighted: false },
      ],
    }));
    const joined = ddl.relTables.join('\n');
    expect(joined).toMatch(/CREATE REL TABLE IF NOT EXISTS MENTIONS \(FROM Atom TO Entity, prominence FLOAT, created_at STRING\)/);
    expect(joined).toMatch(/CREATE REL TABLE IF NOT EXISTS ASSOCIATED \(FROM Entity TO Entity, weight INT64, last_reinforced STRING\)/);
    expect(joined).toMatch(/CREATE REL TABLE IF NOT EXISTS IS_FRIEND_OF \(FROM Entity TO Entity\)/);
  });

  it('emits engine-provided edges (SUPERSEDES, ALIAS_OF, IS_A, SUMMARIZES, REINFORCED_BY, IN_EPISODE)', () => {
    const ddl = buildDdl(minimalSpec());
    const joined = ddl.relTables.join('\n');
    expect(joined).toMatch(/CREATE REL TABLE IF NOT EXISTS SUPERSEDES/);
    expect(joined).toMatch(/CREATE REL TABLE IF NOT EXISTS ALIAS_OF/);
    expect(joined).toMatch(/CREATE REL TABLE IF NOT EXISTS IS_A/);
    expect(joined).toMatch(/CREATE REL TABLE IF NOT EXISTS SUMMARIZES/);
    expect(joined).toMatch(/CREATE REL TABLE IF NOT EXISTS REINFORCED_BY/);
    expect(joined).toMatch(/CREATE REL TABLE IF NOT EXISTS IN_EPISODE/);
  });

  it('skips IN_EPISODE when episodesEnabled is false', () => {
    const ddl = buildDdl(minimalSpec({ episodesEnabled: false }));
    expect(ddl.relTables.join('\n')).not.toMatch(/IN_EPISODE/);
  });

  it('creates FTS indexes for Atom.content and Entity.name', () => {
    const ddl = buildDdl(minimalSpec());
    const fts = ddl.ftsIndexes.join('\n');
    expect(fts).toMatch(/CREATE_FTS_INDEX\('Atom', 'atom_fts', \['content'\]\)/);
    expect(fts).toMatch(/CREATE_FTS_INDEX\('Entity', 'entity_fts', \['name'\]\)/);
  });

  it('rejects reserved occurrence names', () => {
    expect(() => buildDdl(minimalSpec({
      occurrenceKinds: [{ name: 'SUPERSEDES', hasProminence: false }],
    }))).toThrow(/reserved/);
  });

  it('rejects lowercase or invalid rel names', () => {
    expect(() => buildDdl(minimalSpec({
      associationKinds: [{ name: 'lowercase', weighted: false }],
    }))).toThrow(/UPPER_SNAKE_CASE/);
  });

  it('rejects duplicate association or occurrence kinds', () => {
    expect(() => buildDdl(minimalSpec({
      associationKinds: [
        { name: 'X', weighted: false },
        { name: 'X', weighted: false },
      ],
    }))).toThrow(/Duplicate/);
  });

  it('rejects invalid resolver thresholds', () => {
    expect(() => buildDdl(minimalSpec({
      resolverConfig: { weights: {}, acceptThreshold: 0.3, uncertainThreshold: 0.5 },
    }))).toThrow(/resolverConfig/);
  });

  it('respects custom table name overrides', () => {
    const ddl = buildDdl(minimalSpec({ atomTableName: 'Encounter', entityTableName: 'Clinical' }));
    const joined = ddl.nodeTables.join('\n');
    expect(joined).toMatch(/CREATE NODE TABLE IF NOT EXISTS Encounter/);
    expect(joined).toMatch(/CREATE NODE TABLE IF NOT EXISTS Clinical/);
  });
});
