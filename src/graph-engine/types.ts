// ─── Graph Engine Types ─────────────────────────────────────────────────────
// Shared type-agnostic primitives. Each instance type declares a SchemaSpec
// that the engine uses to generate Kuzu DDL, resolve entities, extract LLM
// knowledge, and drive maintenance. See docs/design/graph-engine.md.

// ─── Primitive kinds ────────────────────────────────────────────────────────

/** Free-form string tag on an Atom (e.g. 'decision', 'encounter', 'tweet'). */
export type AtomKind = string;

/** Free-form entity type label (e.g. 'person', 'project', 'medication'). */
export type EntityType = string;

// ─── Declarative bits of a schema ───────────────────────────────────────────

export interface AssociationKindDef {
  /** Kuzu rel-table name. Must be a valid identifier. */
  name: string;
  /** If true, edges carry {weight, last_reinforced}. */
  weighted: boolean;
  /** Optional: constrain to particular entity-type pairs at resolve-time. */
  from?: EntityType;
  to?: EntityType;
}

export interface OccurrenceKindDef {
  /** Kuzu rel-table name for Atom → Entity (e.g. 'MENTIONS', 'PRESCRIBED'). */
  name: string;
  /** Optional: constrain to a specific atom kind. '*' or omitted = any. */
  atomKind?: AtomKind | '*';
  /** Optional: constrain to a specific entity type. '*' or omitted = any. */
  entityType?: EntityType | '*';
  /** If true, edges carry {prominence: FLOAT}. */
  hasProminence: boolean;
}

export interface ResolverConfig {
  /**
   * Feature weights for fit scoring. Built-in features:
   *   name_similarity, recency, context_overlap,
   *   cwd_instance_match, type_match.
   * Types may add custom features via the resolver's feature registry.
   */
  weights: Record<string, number>;
  /** Accept the top candidate as a match if fit_score ≥ this value. */
  acceptThreshold: number;
  /** Top candidate scoring below this → new entity, no alias. */
  uncertainThreshold: number;
}

export type MaintenanceCadence = 'nightly' | 'weekly' | 'monthly' | 'manual';

export interface MaintenancePolicy {
  /** Name from the pass registry (e.g. 'tier-recompute', 'alias-confirm'). */
  pass: string;
  cadence: MaintenanceCadence;
  /** Optional per-pass tuning (thresholds, limits, prompts, etc.). */
  config?: Record<string, unknown>;
}

/** A compact, declarative description of a type's graph shape + policies. */
export interface SchemaSpec {
  /** Type name (e.g. 'general'). */
  typeName: string;

  /** Table names. Defaults applied by schema-builder if omitted. */
  atomTableName?: string;       // default: 'Atom'
  entityTableName?: string;     // default: 'Entity'
  episodeTableName?: string;    // default: 'Episode'

  atomKinds: AtomKind[];
  entityTypes: EntityType[];
  associationKinds: AssociationKindDef[];
  occurrenceKinds: OccurrenceKindDef[];

  episodesEnabled: boolean;
  agingEnabled: boolean;
  reconsolidationEnabled: boolean;
  retrievalCoActivationEnabled: boolean;
  writeMode: 'text' | 'structured' | 'both';
  embeddingsEnabled: boolean;
  /** Dimensionality of atom/entity embeddings. Default 1536 (OpenAI small). */
  embeddingDim?: number;

  /** Build the LLM prompt for extracting entities from an atom's content. */
  extractPrompt: (content: string) => string;

  resolverConfig: ResolverConfig;
  maintenancePolicies: MaintenancePolicy[];
}

// ─── Runtime shape (row-level) ──────────────────────────────────────────────
// These are the shapes stored in Kuzu. Field sets may vary by SchemaSpec
// (embedding/tier/foreign_episode are conditional).

export type Salience = 'low' | 'normal' | 'high';
export type AtomTier = 'hot' | 'warm' | 'cold';
export type EntityStatus = 'active' | 'merged' | 'archived';
export type JobStatus = 'queued' | 'in_progress' | 'done' | 'failed';

export interface Atom {
  id: string;
  content: string;
  kind: AtomKind;
  salience: Salience;
  created_at: string;
  last_accessed: string;
  access_count: number;
  source_instance: string;
  cwd: string | null;
  source_kind: 'consolidate' | 'session-summary' | 'ingestion' | 'cross-instance' | 'maintenance';
  tier?: AtomTier;
  embedding?: number[] | null;
  extracted: boolean;
  superseded_by: string | null;
  foreign_episode: string | null; // JSON-encoded {instance, episode_id} for cross-instance atoms
}

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  first_seen: string;
  last_seen: string;
  mention_count: number;
  aliases: string[];
  embedding?: number[] | null;
  status: EntityStatus;
}

export interface Episode {
  id: string;
  start_time: string;
  end_time: string | null;
  source_instance: string;
  cwd: string | null;
  summary_memory_id: string | null;
  message_count: number;
  closed: boolean;
}

export interface ExtractionJob {
  id: string;
  atom_id: string;
  queued_at: string;
  attempts: number;
  status: JobStatus;
  error: string | null;
}

/** A job returned by `claimNextJob` — status is always 'in_progress'. */
export interface ClaimedJob extends ExtractionJob {
  status: 'in_progress';
}

export interface MaintenanceRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  stats: string; // JSON blob
  trigger: 'cron' | 'manual' | 'threshold';
}

// ─── Write path inputs/outputs ──────────────────────────────────────────────

export interface LifecycleContext {
  source_instance: string;
  cwd: string | null;
  source_kind?: Atom['source_kind'];
  foreign_episode?: { instance: string; episode_id: string } | null;
}

export interface PreExtractedEntity {
  name: string;
  type: EntityType;
  occurrenceKind: string;
  prominence?: number;
}

export interface WriteAtomInput {
  content: string;
  kind: AtomKind;
  salience?: Salience;
  context: LifecycleContext;
  supersedes?: string | string[];
  /** Structured-mode only: skip the LLM extraction queue. */
  preExtracted?: PreExtractedEntity[];
}

export interface WriteAtomResult {
  id: string;
  superseded: string[];
}

// ─── Resolver ───────────────────────────────────────────────────────────────

export interface ResolveContext {
  cwd: string | null;
  source_instance: string;
  episode_id?: string | null;
  /** The other entities extracted alongside this candidate — used for
   *  context_overlap scoring. */
  coEntities: Array<{ name: string; type: EntityType }>;
}

export type ResolveDecision =
  | { kind: 'existing'; entityId: string }
  | { kind: 'new'; entityId: string }
  | { kind: 'alias-suspected'; entityId: string; aliasOf: string; confidence: number };

// ─── Maintenance ────────────────────────────────────────────────────────────

export interface MaintenancePassResult {
  name: string;
  duration_ms: number;
  stats: Record<string, unknown>;
  errors: string[];
}
