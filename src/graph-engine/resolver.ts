// ─── Resolver ───────────────────────────────────────────────────────────────
// Given an entity name + type + surrounding context, decide whether to:
//   (a) accept an existing entity as the target,
//   (b) create a new entity + tentative ALIAS_OF to the closest match, or
//   (c) create a fresh entity with no alias.
//
// Candidate retrieval uses FTS on Entity.name; vector search is added in the
// embeddings phase. The fit score is built-in features × spec weights.
//
// Caller must hold the write lock.

import type { GraphEngineInstance } from './instance.js';
import type { EntityType, ResolveContext, ResolveDecision } from './types.js';
import { computeFitScore } from './fit-features.js';
import {
  createEntity,
  findEntityByExactName,
  bumpMention,
  createSuspectedAlias,
  searchEntitiesByName,
} from './entities.js';
import { logger } from '../shared/logger.js';

const DEFAULT_CANDIDATES_K = 10;

/**
 * Resolve a named entity to an id. Writes may happen (new entity, alias edge,
 * mention bump). Returns the decision + resulting entity id.
 */
export async function resolveEntity(
  engine: GraphEngineInstance,
  name: string,
  type: EntityType,
  ctx: ResolveContext,
): Promise<ResolveDecision> {
  const conn = engine.getConnection();
  const spec = engine.spec;
  const { acceptThreshold, uncertainThreshold } = spec.resolverConfig;

  // ── 1. Exact-match fast path ────────────────────────────────────────────
  // An existing entity with the same name + type is always the right answer.
  // Skipping the scoring dance avoids false aliases on fresh graphs where
  // context_overlap / cwd_instance_match can't contribute yet.
  const exactMatch = await findEntityByExactName(conn, spec, name);
  if (exactMatch && exactMatch.type === type) {
    await bumpMention(conn, spec, exactMatch.id);
    return { kind: 'existing', entityId: exactMatch.id };
  }

  // ── 2. Candidate retrieval ──────────────────────────────────────────────
  const ftsCandidates = await searchEntitiesByName(conn, spec, name, DEFAULT_CANDIDATES_K);
  const byId = new Map<string, typeof ftsCandidates[number]>();
  for (const c of ftsCandidates) byId.set(c.id, c);
  if (exactMatch) byId.set(exactMatch.id, exactMatch);
  const candidates = [...byId.values()];

  if (candidates.length === 0) {
    const id = await createEntity(conn, spec, { name, type });
    await bumpMention(conn, spec, id);
    return { kind: 'new', entityId: id };
  }

  // ── 3. Score candidates ────────────────────────────────────────────────
  const scored = await Promise.all(
    candidates.map(async (c) => ({
      candidate: c,
      score: await computeFitScore(conn, spec, c, name, type, ctx),
    })),
  );
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0]!;
  logger.debug(
    { name, type, topScore: top.score.toFixed(3), topName: top.candidate.name, totalCandidates: scored.length },
    'resolver scored',
  );

  // ── 4. Decide ──────────────────────────────────────────────────────────
  if (top.score >= acceptThreshold) {
    await bumpMention(conn, spec, top.candidate.id);
    return { kind: 'existing', entityId: top.candidate.id };
  }

  if (top.score >= uncertainThreshold) {
    const newId = await createEntity(conn, spec, { name, type });
    await bumpMention(conn, spec, newId);
    await createSuspectedAlias(conn, spec, newId, top.candidate.id, top.score);
    return {
      kind: 'alias-suspected',
      entityId: newId,
      aliasOf: top.candidate.id,
      confidence: top.score,
    };
  }

  // Below uncertain → new
  const newId = await createEntity(conn, spec, { name, type });
  await bumpMention(conn, spec, newId);
  return { kind: 'new', entityId: newId };
}
