// ─── Schema Builder ─────────────────────────────────────────────────────────
// Generates Kuzu DDL (node tables, rel tables, FTS indexes, migrations) from
// a declarative SchemaSpec. Per-type code declares the spec; this module
// emits the Cypher strings the engine's initializer will execute.

import type { SchemaSpec } from './types.js';

export interface GeneratedDdl {
  /** NODE TABLE statements (run first). */
  nodeTables: string[];
  /** REL TABLE statements (run after nodes). */
  relTables: string[];
  /** ALTER TABLE ADD COLUMN statements — safe to re-run, errors ignored. */
  migrations: string[];
  /** FTS index creation (CALL CREATE_FTS_INDEX). */
  ftsIndexes: string[];
  /** FTS index drops (for rebuilds). */
  ftsDrops: string[];
}

const DEFAULT_TABLE_NAMES = {
  atom: 'Atom',
  entity: 'Entity',
  episode: 'Episode',
  extractionJob: 'ExtractionJob',
  maintenanceRun: 'MaintenanceRun',
} as const;

const RESERVED_EDGE_NAMES = new Set([
  'IN_EPISODE', 'SUPERSEDES', 'SUMMARIZES', 'REINFORCED_BY', 'ALIAS_OF', 'IS_A',
]);

/**
 * Emit all DDL statements required to realize a SchemaSpec in a fresh Kuzu DB.
 * Callers run statements in the returned order.
 */
export function buildDdl(spec: SchemaSpec): GeneratedDdl {
  const atomTable = spec.atomTableName ?? DEFAULT_TABLE_NAMES.atom;
  const entityTable = spec.entityTableName ?? DEFAULT_TABLE_NAMES.entity;
  const episodeTable = spec.episodeTableName ?? DEFAULT_TABLE_NAMES.episode;
  const jobTable = DEFAULT_TABLE_NAMES.extractionJob;
  const runTable = DEFAULT_TABLE_NAMES.maintenanceRun;
  const embDim = spec.embeddingDim ?? 1536;

  validateSpec(spec);

  const nodeTables: string[] = [];
  const relTables: string[] = [];
  const migrations: string[] = [];
  const ftsIndexes: string[] = [];
  const ftsDrops: string[] = [];

  // ─── Node tables ─────────────────────────────────────────────────────────

  nodeTables.push(buildAtomTable(atomTable, spec.agingEnabled, spec.embeddingsEnabled, embDim));

  nodeTables.push(buildEntityTable(entityTable, spec.embeddingsEnabled, embDim));

  if (spec.episodesEnabled) {
    nodeTables.push(buildEpisodeTable(episodeTable));
  }

  nodeTables.push(buildExtractionJobTable(jobTable));
  nodeTables.push(buildMaintenanceRunTable(runTable));

  // ─── Rel tables ──────────────────────────────────────────────────────────

  // Occurrences: Atom → Entity (one table per OccurrenceKind)
  for (const occ of spec.occurrenceKinds) {
    if (RESERVED_EDGE_NAMES.has(occ.name)) {
      throw new Error(`Occurrence kind "${occ.name}" conflicts with a reserved rel-table name`);
    }
    const props = occ.hasProminence ? ', prominence FLOAT, created_at STRING' : ', created_at STRING';
    relTables.push(
      `CREATE REL TABLE IF NOT EXISTS ${occ.name} (FROM ${atomTable} TO ${entityTable}${props})`,
    );
  }

  // Associations: Entity ↔ Entity
  for (const assoc of spec.associationKinds) {
    const props = assoc.weighted
      ? ', weight INT64, last_reinforced STRING'
      : '';
    relTables.push(
      `CREATE REL TABLE IF NOT EXISTS ${assoc.name} (FROM ${entityTable} TO ${entityTable}${props})`,
    );
  }

  // Engine-provided edges
  if (spec.episodesEnabled) {
    relTables.push(`CREATE REL TABLE IF NOT EXISTS IN_EPISODE (FROM ${atomTable} TO ${episodeTable})`);
  }
  relTables.push(`CREATE REL TABLE IF NOT EXISTS SUPERSEDES (FROM ${atomTable} TO ${atomTable}, created_at STRING)`);
  relTables.push(`CREATE REL TABLE IF NOT EXISTS SUMMARIZES (FROM ${atomTable} TO ${atomTable})`);
  relTables.push(`CREATE REL TABLE IF NOT EXISTS REINFORCED_BY (FROM ${atomTable} TO ${atomTable}, weight INT64)`);
  relTables.push(`CREATE REL TABLE IF NOT EXISTS ALIAS_OF (FROM ${entityTable} TO ${entityTable}, confidence FLOAT, status STRING)`);
  relTables.push(`CREATE REL TABLE IF NOT EXISTS IS_A (FROM ${entityTable} TO ${entityTable})`);

  // ─── Migrations (additive) ───────────────────────────────────────────────

  // Per-spec additive fields applied via ALTER TABLE — wrapped in try/ignore by caller.
  migrations.push(`ALTER TABLE ${atomTable} ADD tier STRING DEFAULT 'hot'`);
  if (spec.embeddingsEnabled) {
    migrations.push(`ALTER TABLE ${atomTable} ADD embedding FLOAT[${embDim}]`);
    migrations.push(`ALTER TABLE ${entityTable} ADD embedding FLOAT[${embDim}]`);
  }
  migrations.push(`ALTER TABLE ${atomTable} ADD foreign_episode STRING`);
  migrations.push(`ALTER TABLE ${atomTable} ADD superseded_by STRING`);
  migrations.push(`ALTER TABLE ${atomTable} ADD extracted BOOLEAN DEFAULT false`);

  // ─── FTS indexes ─────────────────────────────────────────────────────────

  ftsIndexes.push(
    `CALL CREATE_FTS_INDEX('${entityTable}', 'entity_fts', ['name'])`,
  );
  ftsDrops.push(
    `CALL DROP_FTS_INDEX('${entityTable}', 'entity_fts')`,
  );
  ftsIndexes.push(
    `CALL CREATE_FTS_INDEX('${atomTable}', 'atom_fts', ['content'])`,
  );
  ftsDrops.push(
    `CALL DROP_FTS_INDEX('${atomTable}', 'atom_fts')`,
  );

  return { nodeTables, relTables, migrations, ftsIndexes, ftsDrops };
}

// ─── Table builders ─────────────────────────────────────────────────────────

function buildAtomTable(name: string, _aging: boolean, embeddings: boolean, embDim: number): string {
  // tier is always present (cheap STRING); `agingEnabled` controls whether
  // the engine promotes/demotes it, not whether it exists.
  const fields = [
    'id STRING',
    'content STRING',
    'kind STRING',
    'salience STRING',
    'created_at STRING',
    'last_accessed STRING',
    'access_count INT64 DEFAULT 0',
    'source_instance STRING',
    'cwd STRING',
    'source_kind STRING',
    'extracted BOOLEAN DEFAULT false',
    'superseded_by STRING',
    'foreign_episode STRING',
    `tier STRING DEFAULT 'hot'`,
  ];
  if (embeddings) fields.push(`embedding FLOAT[${embDim}]`);
  fields.push('PRIMARY KEY (id)');
  return `CREATE NODE TABLE IF NOT EXISTS ${name} (\n  ${fields.join(',\n  ')}\n)`;
}

function buildEntityTable(name: string, embeddings: boolean, embDim: number): string {
  const fields = [
    'id STRING',
    'name STRING',
    'type STRING',
    'first_seen STRING',
    'last_seen STRING',
    'mention_count INT64 DEFAULT 0',
    'aliases STRING[]',
    `status STRING DEFAULT 'active'`,
  ];
  if (embeddings) fields.push(`embedding FLOAT[${embDim}]`);
  fields.push('PRIMARY KEY (id)');
  return `CREATE NODE TABLE IF NOT EXISTS ${name} (\n  ${fields.join(',\n  ')}\n)`;
}

function buildEpisodeTable(name: string): string {
  return `CREATE NODE TABLE IF NOT EXISTS ${name} (
  id STRING,
  start_time STRING,
  end_time STRING,
  source_instance STRING,
  cwd STRING,
  summary_memory_id STRING,
  message_count INT64 DEFAULT 0,
  closed BOOLEAN DEFAULT false,
  PRIMARY KEY (id)
)`;
}

function buildExtractionJobTable(name: string): string {
  return `CREATE NODE TABLE IF NOT EXISTS ${name} (
  id STRING,
  atom_id STRING,
  queued_at STRING,
  attempts INT64 DEFAULT 0,
  status STRING DEFAULT 'queued',
  error STRING,
  PRIMARY KEY (id)
)`;
}

function buildMaintenanceRunTable(name: string): string {
  return `CREATE NODE TABLE IF NOT EXISTS ${name} (
  id STRING,
  started_at STRING,
  finished_at STRING,
  stats STRING,
  trigger STRING,
  PRIMARY KEY (id)
)`;
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateSpec(spec: SchemaSpec): void {
  if (!spec.typeName) throw new Error('SchemaSpec.typeName is required');
  if (!spec.atomKinds.length) throw new Error('SchemaSpec.atomKinds must be non-empty');
  if (!spec.entityTypes.length) throw new Error('SchemaSpec.entityTypes must be non-empty');
  if (!spec.occurrenceKinds.length) {
    throw new Error('SchemaSpec.occurrenceKinds must declare at least one (e.g. MENTIONS)');
  }

  const seenAssoc = new Set<string>();
  for (const a of spec.associationKinds) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(a.name)) {
      throw new Error(`associationKinds[*].name must be UPPER_SNAKE_CASE: got "${a.name}"`);
    }
    if (seenAssoc.has(a.name)) throw new Error(`Duplicate associationKind: "${a.name}"`);
    seenAssoc.add(a.name);
  }

  const seenOcc = new Set<string>();
  for (const o of spec.occurrenceKinds) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(o.name)) {
      throw new Error(`occurrenceKinds[*].name must be UPPER_SNAKE_CASE: got "${o.name}"`);
    }
    if (seenOcc.has(o.name)) throw new Error(`Duplicate occurrenceKind: "${o.name}"`);
    seenOcc.add(o.name);
  }

  if (spec.embeddingsEnabled && spec.embeddingDim && spec.embeddingDim <= 0) {
    throw new Error('embeddingDim must be > 0 when embeddingsEnabled');
  }

  const { acceptThreshold, uncertainThreshold } = spec.resolverConfig;
  if (!(acceptThreshold > uncertainThreshold && uncertainThreshold >= 0 && acceptThreshold <= 1)) {
    throw new Error('resolverConfig: require 0 ≤ uncertainThreshold < acceptThreshold ≤ 1');
  }
}
