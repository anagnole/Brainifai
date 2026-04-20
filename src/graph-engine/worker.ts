// ─── Extraction worker ──────────────────────────────────────────────────────
// Polls the ExtractionJob queue. For each claimed job:
//   1. Under lock: claim + read atom
//   2. OUTSIDE the lock: call LLM to extract entities
//   3. Under lock: resolve each entity, create MENTIONS, bump CO_OCCURS, mark
//      atom extracted, mark job done
//
// LLM calls happen outside the lock so writes don't block for seconds per
// atom. Idempotent by design: re-processing a done atom is a no-op.

import { withLock } from './lock.js';
import { complete, extractJsonOr } from './llm.js';
import {
  claimNextJob,
  markJobDone,
  markJobFailed,
  requeueJob,
  resetStaleInProgress,
} from './queue.js';
import { resolveEntity } from './resolver.js';
import {
  createOccurrence,
  bumpAssociation,
  markAtomExtracted,
  fetchAtomById,
} from './occurrences.js';
import { embed, embedBatch } from './embedding.js';
import type { GraphEngineInstance } from './instance.js';
import type { ClaimedJob, EntityType, SchemaSpec } from './types.js';
import kuzu from 'kuzu';
import { logger } from '../shared/logger.js';

type Conn = InstanceType<typeof kuzu.Connection>;

// ─── Public types ───────────────────────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  /** 0..1; how central this entity is to the atom. Default 0.5 if omitted. */
  prominence?: number;
}

export type ExtractFn = (content: string) => Promise<ExtractedEntity[]>;

export interface WorkerOptions {
  /** Override for tests; defaults to LLM extraction via `spec.extractPrompt`. */
  extract?: ExtractFn;
  /** In-progress job older than this is reset on each tick. Default 5min. */
  staleMs?: number;
  /** Poll interval when the queue is empty. Default 1000ms. */
  emptyPollMs?: number;
  /** Max attempts before marking a job failed permanently. Default 5. */
  maxAttempts?: number;
  /** Base for exponential backoff (ms). Default 1000 → 1s, 2s, 4s, 8s, 16s. */
  backoffBaseMs?: number;
  /** Occurrence kind used for MENTIONS edges. Default = first declared. */
  occurrenceKind?: string;
  /** Association kind used for CO_OCCURS. Default = first declared. */
  associationKind?: string;
}

export type TickResult = 'done' | 'empty' | 'failed';

export interface WorkerHandle {
  /** Stop the loop after the current job finishes. */
  stop(): Promise<void>;
}

// ─── Default extractor (LLM) ────────────────────────────────────────────────

function defaultExtractorFactory(engine: GraphEngineInstance): ExtractFn {
  return async (content: string) => {
    const prompt = engine.spec.extractPrompt(content);
    const text = await complete(prompt, { maxTokens: 2048 });

    // Accept either {entities: [...]} or a bare array of entities.
    const parsed = extractJsonOr<{ entities?: ExtractedEntity[] } | ExtractedEntity[]>(
      text,
      [],
    );
    if (Array.isArray(parsed)) return parsed;
    return parsed.entities ?? [];
  };
}

// ─── Tick ───────────────────────────────────────────────────────────────────

/**
 * Process (at most) one job. Returns:
 *   - 'done' if a job was fully processed
 *   - 'empty' if the queue was empty
 *   - 'failed' if extraction failed and the job was requeued or marked failed
 */
export async function processOneJob(
  engine: GraphEngineInstance,
  options: WorkerOptions = {},
): Promise<TickResult> {
  const spec = engine.spec;
  const extract = options.extract ?? defaultExtractorFactory(engine);
  const maxAttempts = options.maxAttempts ?? 5;
  const backoffBase = options.backoffBaseMs ?? 1000;
  const staleMs = options.staleMs ?? 5 * 60 * 1000;
  const occurrenceKind =
    options.occurrenceKind ?? spec.occurrenceKinds[0]?.name ?? 'MENTIONS';
  const associationKind =
    options.associationKind ?? spec.associationKinds[0]?.name ?? 'ASSOCIATED';

  // ── 1. Under lock: reset stale, claim next, read atom ─────────────────────
  type Claim = { job: ClaimedJob; atom: Awaited<ReturnType<typeof fetchAtomById>> };
  const claim = await withLock<Claim | null>(engine.lockPath, async () => {
    const conn = engine.getConnection();
    await resetStaleInProgress(conn, staleMs);
    const job = await claimNextJob(conn);
    if (!job) return null;
    const atom = await fetchAtomById(conn, spec, job.atom_id);
    return { job, atom };
  });

  if (!claim) return 'empty';
  const { job, atom } = claim;

  if (!atom) {
    // Atom missing — probably deleted. Mark job done to drop it from the queue.
    await withLock(engine.lockPath, async () => {
      await markJobDone(engine.getConnection(), job.id);
    });
    logger.warn({ jobId: job.id }, 'Atom missing for job; dropping');
    return 'done';
  }

  if (atom.extracted) {
    // Already extracted in a prior run — don't redo work.
    await withLock(engine.lockPath, async () => {
      await markJobDone(engine.getConnection(), job.id);
    });
    return 'done';
  }

  // ── 2. OUTSIDE the lock: LLM extraction + embeddings ─────────────────────
  let entities: ExtractedEntity[];
  let atomEmbedding: number[] | null = null;
  let entityEmbeddings: number[][] = [];
  try {
    entities = await extract(atom.content);
    entities = entities.filter((e) => e && e.name && e.name.trim().length > 0);

    if (spec.embeddingsEnabled) {
      // Compute atom + entity embeddings in parallel while the lock is free.
      const [atomVec, entityVecs] = await Promise.all([
        embed(atom.content),
        entities.length > 0 ? embedBatch(entities.map((e) => e.name)) : Promise.resolve([] as number[][]),
      ]);
      atomEmbedding = atomVec;
      entityEmbeddings = entityVecs;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ jobId: job.id, atomId: atom.id, err: msg }, 'Extraction failed');
    await withLock(engine.lockPath, async () => {
      if (job.attempts >= maxAttempts) {
        await markJobFailed(engine.getConnection(), job.id, msg);
      } else {
        const backoff = backoffBase * Math.pow(2, job.attempts - 1);
        await requeueJob(engine.getConnection(), job.id, backoff);
      }
    });
    return 'failed';
  }

  // ── 3. Under lock: resolve + write MENTIONS + CO_OCCURS + mark done ───────
  try {
    await withLock(engine.lockPath, async () => {
      const conn = engine.getConnection();

      // Resolve each extracted entity. Order matters slightly: previously
      // resolved entities are visible to subsequent ones via the graph.
      const resolvedIds: string[] = [];
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i]!;
        const decision = await resolveEntity(engine, entity.name, entity.type, {
          cwd: atom.cwd || null,
          source_instance: atom.source_instance,
          coEntities: entities
            .filter((_, j) => j !== i)
            .map((o) => ({ name: o.name, type: o.type })),
        });
        resolvedIds.push(decision.entityId);

        // Store embedding on the entity row if we computed one and the
        // resolver created a new entity for it.
        if (spec.embeddingsEnabled && entityEmbeddings[i] && decision.kind !== 'existing') {
          await setEntityEmbedding(conn, spec, decision.entityId, entityEmbeddings[i]!);
        }
      }

      // MENTIONS edges (idempotent)
      for (let i = 0; i < entities.length; i++) {
        await createOccurrence(
          conn,
          spec,
          occurrenceKind,
          atom.id,
          resolvedIds[i]!,
          entities[i]!.prominence ?? 0.5,
        );
      }

      // CO_OCCURS pairwise — only bump weight if the MENTIONS was newly added
      // in this run (that's handled inside bumpAssociation indirectly: we call
      // it unconditionally, but since we only get here when the atom hadn't
      // been extracted yet, this is the first time the pair is seen together).
      for (let i = 0; i < resolvedIds.length; i++) {
        for (let j = i + 1; j < resolvedIds.length; j++) {
          await bumpAssociation(conn, spec, associationKind, resolvedIds[i]!, resolvedIds[j]!);
        }
      }

      // Store the atom embedding.
      if (spec.embeddingsEnabled && atomEmbedding) {
        await setAtomEmbedding(conn, spec, atom.id, atomEmbedding);
      }

      await markAtomExtracted(conn, spec, atom.id);
      await markJobDone(conn, job.id);
    });
    return 'done';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ jobId: job.id, atomId: atom.id, err: msg }, 'Post-extraction write failed');
    await withLock(engine.lockPath, async () => {
      if (job.attempts >= maxAttempts) {
        await markJobFailed(engine.getConnection(), job.id, msg);
      } else {
        await requeueJob(engine.getConnection(), job.id, 5000);
      }
    });
    return 'failed';
  }
}

// ─── Worker loop ────────────────────────────────────────────────────────────

/**
 * Start a polling loop. Returns a handle with `stop()` that waits for the
 * current job to complete before resolving.
 */
export function startWorker(
  engine: GraphEngineInstance,
  options: WorkerOptions = {},
): WorkerHandle {
  let running = true;
  let currentTick: Promise<TickResult> | null = null;

  const loop = async () => {
    const emptyPollMs = options.emptyPollMs ?? 1000;
    while (running) {
      currentTick = processOneJob(engine, options);
      const result = await currentTick;
      currentTick = null;
      if (!running) break;
      if (result === 'empty') {
        await sleep(emptyPollMs);
      } else if (result === 'failed') {
        await sleep(500); // small cooldown on failure
      }
    }
  };

  loop().catch((err) => {
    logger.error({ err: (err as Error).message }, 'Worker loop crashed');
  });

  return {
    stop: async () => {
      running = false;
      if (currentTick) {
        try { await currentTick; } catch { /* ignore */ }
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Embedding persistence ──────────────────────────────────────────────────

async function setAtomEmbedding(
  conn: Conn,
  spec: SchemaSpec,
  atomId: string,
  vec: number[],
): Promise<void> {
  const atomTable = spec.atomTableName ?? 'Atom';
  const ps = await conn.prepare(`
    MATCH (a:${atomTable} {id: $id}) SET a.embedding = $vec
  `);
  await conn.execute(ps, { id: atomId, vec });
}

async function setEntityEmbedding(
  conn: Conn,
  spec: SchemaSpec,
  entityId: string,
  vec: number[],
): Promise<void> {
  const entityTable = spec.entityTableName ?? 'Entity';
  const ps = await conn.prepare(`
    MATCH (e:${entityTable} {id: $id}) SET e.embedding = $vec
  `);
  await conn.execute(ps, { id: entityId, vec });
}
