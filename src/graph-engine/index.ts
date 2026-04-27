// ─── Graph Engine — public entry points ─────────────────────────────────────

export type {
  SchemaSpec,
  AtomKind,
  EntityType,
  AssociationKindDef,
  OccurrenceKindDef,
  ResolverConfig,
  MaintenancePolicy,
  MaintenanceCadence,
  Atom,
  Entity,
  Episode,
  ExtractionJob,
  ClaimedJob,
  MaintenanceRun,
  Salience,
  AtomTier,
  EntityStatus,
  JobStatus,
  LifecycleContext,
  PreExtractedEntity,
  WriteAtomInput,
  WriteAtomResult,
  ResolveContext,
  ResolveDecision,
  MaintenancePassResult,
} from './types.js';

export { GraphEngineInstance, type GraphEngineConfig } from './instance.js';
export { getEngine, ensureWorker, closeEngine, closeAllEngines } from './singleton.js';
export { buildDdl, type GeneratedDdl } from './schema-builder.js';
export {
  complete,
  extractJson,
  extractJsonOr,
  getProvider,
  DEFAULT_MODEL,
  type CompleteOptions,
} from './llm.js';
export { acquireLock, withLock, isLocked, type LockHandle, type LockOptions } from './lock.js';
export {
  enqueueJob,
  claimNextJob,
  markJobDone,
  markJobFailed,
  requeueJob,
  resetStaleInProgress,
  countByStatus,
} from './queue.js';
export { writeAtom, writeAtoms } from './write-path.js';
export { resolveEntity } from './resolver.js';
export {
  processOneJob,
  startWorker,
  type ExtractedEntity,
  type ExtractFn,
  type WorkerOptions,
  type WorkerHandle,
  type TickResult,
} from './worker.js';
export {
  createOccurrence,
  bumpAssociation,
  markAtomExtracted,
  fetchAtomById,
} from './occurrences.js';
export {
  bumpReconsolidation,
  reinforceCoOccurrence,
  type ReconsolidateOptions,
} from './reconsolidation.js';
export {
  fetchAtomsByOrder,
  fetchMentioningAtoms,
  fetchAtomsByEpisode,
  spreadActivation,
  type FetchAtomsByOrderInput,
  type FetchMentioningAtomsInput,
  type FetchAtomsByEpisodeInput,
  type SpreadActivationInput,
  type ActivationSeed,
  type ActivationResult,
  type MentioningAtom,
} from './reads.js';
export {
  createEntity,
  findEntityByExactName,
  findEntitiesByNameCI,
  findEntitiesByPartialName,
  resolveCueToSeeds,
  bumpMention,
  createSuspectedAlias,
  searchEntitiesByName,
  type CreateEntityInput,
} from './entities.js';
export {
  nameSimilarity,
  recency,
  typeMatch,
  contextOverlap,
  cwdInstanceMatch,
  computeFitScore,
} from './fit-features.js';
export {
  startEpisode,
  closeEpisode,
  findActiveEpisode,
  getOrCreateActiveEpisode,
  type StartEpisodeInput,
} from './episode.js';
export {
  runMaintenance,
  getPass,
  listPasses,
  type MaintenancePass,
  type MaintenanceTrigger,
  type PassStats,
  type RunOptions,
  type RunReport,
} from './maintenance/index.js';
