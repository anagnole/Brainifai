// ─── Fit-score feature functions ────────────────────────────────────────────
// Each feature returns a score in [0, 1]. The resolver multiplies these by
// the type's `resolverConfig.weights` and sums for the final fit score.
//
// Pure functions live synchronously; DB-touching features are async.

import kuzu from 'kuzu';
import type { Entity, EntityType, ResolveContext, SchemaSpec } from './types.js';

type Conn = InstanceType<typeof kuzu.Connection>;

// ─── Name similarity (token Jaccard with light bigram boost) ────────────────

/**
 * Similarity between two names in [0, 1]. Token Jaccard handles "Anna" vs
 * "Anna Smith" sensibly; bigram overlap catches typos and substring matches.
 */
export function nameSimilarity(a: string, b: string): number {
  const jaccard = tokenJaccard(a, b);
  const bigram = bigramJaccard(a, b);
  return Math.min(1, 0.7 * jaccard + 0.3 * bigram);
}

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

function tokenJaccard(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function bigrams(s: string): Set<string> {
  const lower = s.toLowerCase();
  const grams = new Set<string>();
  for (let i = 0; i < lower.length - 1; i++) {
    grams.add(lower.slice(i, i + 2));
  }
  return grams;
}

function bigramJaccard(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  const union = ba.size + bb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ─── Recency ────────────────────────────────────────────────────────────────

/** 1.0 if seen today, decays linearly to 0 after `horizonDays`. Default 365. */
export function recency(candidate: Entity, horizonDays = 365): number {
  const last = Date.parse(candidate.last_seen);
  if (isNaN(last)) return 0;
  const days = (Date.now() - last) / 86_400_000;
  if (days <= 0) return 1;
  return Math.max(0, 1 - days / horizonDays);
}

// ─── Type match ─────────────────────────────────────────────────────────────

/** 1 if types match, 0 otherwise. Use when type is meaningful per spec. */
export function typeMatch(candidate: Entity, queryType: EntityType): number {
  return candidate.type === queryType ? 1 : 0;
}

// ─── Context overlap (requires DB) ──────────────────────────────────────────

/**
 * Fraction of the memory's co-entities that this candidate already co-occurs
 * with in the graph. Looks at ALL declared association kinds (not just the
 * first) and treats associations as undirected.
 * Returns in [0, 1]; scaled against max(3, coEntities.length).
 */
export async function contextOverlap(
  conn: Conn,
  spec: SchemaSpec,
  candidateId: string,
  coEntityNames: string[],
): Promise<number> {
  if (coEntityNames.length === 0) return 0;
  const assocKinds = spec.associationKinds.map((a) => a.name);
  if (assocKinds.length === 0) return 0;

  const entityTable = spec.entityTableName ?? 'Entity';
  // Union over association kinds. Undirected via two MATCH clauses.
  const matches = assocKinds
    .map((k) => `
      MATCH (c:${entityTable} {id: $cid})-[:${k}]-(other:${entityTable})
      WHERE other.name IN $names
      RETURN DISTINCT other.id AS oid
    `)
    .join(' UNION ');

  try {
    const ps = await conn.prepare(matches);
    const result = await conn.execute(ps, { cid: candidateId, names: coEntityNames });
    const rows = await firstResult(result).getAll() as Array<{ oid: string }>;
    const shared = rows.length;
    return Math.min(1, shared / Math.max(3, coEntityNames.length));
  } catch {
    return 0;
  }
}

// ─── cwd / source-instance match ────────────────────────────────────────────

/**
 * Boolean (as 0/1): has this candidate been mentioned by any Atom in the
 * current cwd or source_instance? Uses Kuzu MENTIONS-ish traversal over
 * all declared occurrence kinds.
 *
 * Heuristic: we check the first occurrence kind only to keep the query cheap.
 * Types with multi-kind occurrences can refine this later.
 */
export async function cwdInstanceMatch(
  conn: Conn,
  spec: SchemaSpec,
  candidateId: string,
  ctx: ResolveContext,
): Promise<number> {
  const firstOcc = spec.occurrenceKinds[0];
  if (!firstOcc) return 0;

  const atomTable = spec.atomTableName ?? 'Atom';
  const entityTable = spec.entityTableName ?? 'Entity';
  const ps = await conn.prepare(`
    MATCH (a:${atomTable})-[:${firstOcc.name}]->(e:${entityTable} {id: $cid})
    WHERE a.cwd = $cwd OR a.source_instance = $si
    RETURN count(a) AS n
    LIMIT 1
  `);
  try {
    const result = await conn.execute(ps, {
      cid: candidateId,
      cwd: ctx.cwd ?? '',
      si: ctx.source_instance,
    });
    const rows = await firstResult(result).getAll() as Array<{ n: number | bigint }>;
    return (rows[0] && Number(rows[0].n) > 0) ? 1 : 0;
  } catch {
    return 0;
  }
}

// ─── Aggregator ─────────────────────────────────────────────────────────────

/** Run all applicable features and return a weighted score in [0, 1]. */
export async function computeFitScore(
  conn: Conn,
  spec: SchemaSpec,
  candidate: Entity,
  queryName: string,
  queryType: EntityType,
  ctx: ResolveContext,
): Promise<number> {
  const w = spec.resolverConfig.weights;
  const coNames = ctx.coEntities.map((c) => c.name).filter((n) => n !== queryName);

  const [overlap, cwdInst] = await Promise.all([
    (w.context_overlap ?? 0) > 0
      ? contextOverlap(conn, spec, candidate.id, coNames)
      : Promise.resolve(0),
    (w.cwd_instance_match ?? 0) > 0
      ? cwdInstanceMatch(conn, spec, candidate.id, ctx)
      : Promise.resolve(0),
  ]);

  const features: Record<string, number> = {
    name_similarity: nameSimilarity(candidate.name, queryName),
    recency: recency(candidate),
    context_overlap: overlap,
    cwd_instance_match: cwdInst,
    type_match: typeMatch(candidate, queryType),
  };

  let score = 0;
  let totalWeight = 0;
  for (const [feature, weight] of Object.entries(w)) {
    if (typeof weight !== 'number') continue;
    const value = features[feature] ?? 0;
    score += value * weight;
    totalWeight += weight;
  }

  // Normalize so the score is on [0, 1] even if weights don't sum to 1.
  return totalWeight > 0 ? score / totalWeight : 0;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type KuzuQueryResult = Awaited<ReturnType<Conn['execute']>>;

function firstResult(r: KuzuQueryResult): Exclude<KuzuQueryResult, unknown[]> {
  return (Array.isArray(r) ? r[0] : r) as Exclude<KuzuQueryResult, unknown[]>;
}
