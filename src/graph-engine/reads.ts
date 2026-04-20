// ─── Engine read primitives ─────────────────────────────────────────────────
// Building blocks for per-type retrieval functions (working_memory, associate,
// recall_episode, etc.). These do NOT bump reconsolidation — that's the
// caller's job after surfacing results.

import kuzu from 'kuzu';
import type { GraphEngineInstance } from './instance.js';
import type { Atom, AtomKind, AtomTier, Salience, SchemaSpec } from './types.js';

type Conn = InstanceType<typeof kuzu.Connection>;

// ─── fetchAtomsByOrder ──────────────────────────────────────────────────────

export interface FetchAtomsByOrderInput {
  orderBy: 'last_accessed' | 'created_at';
  direction?: 'asc' | 'desc';
  limit: number;
  filter?: {
    cwd?: string;
    source_instance?: string;
    kind?: AtomKind;
    kinds?: AtomKind[];
    excludeSuperseded?: boolean; // default true
  };
}

export async function fetchAtomsByOrder(
  engine: GraphEngineInstance,
  input: FetchAtomsByOrderInput,
): Promise<Atom[]> {
  const spec = engine.spec;
  const atomTable = spec.atomTableName ?? 'Atom';
  const conn = engine.getConnection();
  const dir = (input.direction ?? 'desc').toUpperCase() as 'ASC' | 'DESC';
  const excludeSup = input.filter?.excludeSuperseded ?? true;

  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (input.filter?.cwd) {
    where.push('a.cwd = $cwd');
    params.cwd = input.filter.cwd;
  }
  if (input.filter?.source_instance) {
    where.push('a.source_instance = $si');
    params.si = input.filter.source_instance;
  }
  if (input.filter?.kind) {
    where.push('a.kind = $kind');
    params.kind = input.filter.kind;
  } else if (input.filter?.kinds && input.filter.kinds.length > 0) {
    where.push('a.kind IN $kinds');
    params.kinds = input.filter.kinds;
  }
  if (excludeSup) {
    where.push(`(a.superseded_by = '' OR a.superseded_by IS NULL)`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const query = `
    MATCH (a:${atomTable})
    ${whereClause}
    RETURN a.id AS id, a.content AS content, a.kind AS kind, a.salience AS salience,
           a.created_at AS created_at, a.last_accessed AS last_accessed,
           a.access_count AS access_count, a.source_instance AS source_instance,
           a.cwd AS cwd, a.source_kind AS source_kind,
           a.tier AS tier, a.extracted AS extracted,
           a.superseded_by AS superseded_by, a.foreign_episode AS foreign_episode
    ORDER BY a.${input.orderBy} ${dir}
    LIMIT $limit
  `;
  params.limit = input.limit;
  const ps = await conn.prepare(query);
  const result = await conn.execute(ps, params as never);
  const rows = await firstResult(result).getAll() as Array<Record<string, unknown>>;
  return rows.map(rowToAtom);
}

// ─── fetchMentioningAtoms ───────────────────────────────────────────────────

export interface FetchMentioningAtomsInput {
  entityIds: string[];
  limit: number;
  occurrenceKind?: string; // default: first declared
  filter?: {
    cwd?: string;
    excludeSuperseded?: boolean;
  };
  /** If provided, returns only atoms whose prominence is ≥ this on the edge. */
  minProminence?: number;
}

/**
 * Returns atoms that MENTION any of the given entities, deduped. Each atom
 * carries an aggregate score = sum of (edge.prominence) across matching
 * edges, returned alongside the atom fields.
 */
export interface MentioningAtom extends Atom {
  mention_score: number;
  matched_entities: number;
}

export async function fetchMentioningAtoms(
  engine: GraphEngineInstance,
  input: FetchMentioningAtomsInput,
): Promise<MentioningAtom[]> {
  if (input.entityIds.length === 0) return [];
  const spec = engine.spec;
  const atomTable = spec.atomTableName ?? 'Atom';
  const entityTable = spec.entityTableName ?? 'Entity';
  const occKind = input.occurrenceKind ?? spec.occurrenceKinds[0]?.name ?? 'MENTIONS';
  const excludeSup = input.filter?.excludeSuperseded ?? true;
  const conn = engine.getConnection();

  const where: string[] = ['e.id IN $ids'];
  const params: Record<string, unknown> = { ids: input.entityIds };
  if (input.filter?.cwd) {
    where.push('a.cwd = $cwd');
    params.cwd = input.filter.cwd;
  }
  if (excludeSup) where.push(`(a.superseded_by = '' OR a.superseded_by IS NULL)`);
  if (input.minProminence !== undefined) {
    where.push('r.prominence >= $prom');
    params.prom = input.minProminence;
  }

  const query = `
    MATCH (a:${atomTable})-[r:${occKind}]->(e:${entityTable})
    WHERE ${where.join(' AND ')}
    WITH a, sum(coalesce(r.prominence, 0.5)) AS mention_score, count(DISTINCT e) AS matched
    RETURN a.id AS id, a.content AS content, a.kind AS kind, a.salience AS salience,
           a.created_at AS created_at, a.last_accessed AS last_accessed,
           a.access_count AS access_count, a.source_instance AS source_instance,
           a.cwd AS cwd, a.source_kind AS source_kind,
           a.tier AS tier, a.extracted AS extracted,
           a.superseded_by AS superseded_by, a.foreign_episode AS foreign_episode,
           mention_score, matched
    ORDER BY mention_score DESC
    LIMIT $limit
  `;
  params.limit = input.limit;
  const ps = await conn.prepare(query);
  const result = await conn.execute(ps, params as never);
  const rows = await firstResult(result).getAll() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ...rowToAtom(r),
    mention_score: Number(r.mention_score ?? 0),
    matched_entities: Number(r.matched ?? 0),
  }));
}

// ─── fetchAtomsByEpisode ────────────────────────────────────────────────────

export interface FetchAtomsByEpisodeInput {
  episodeIds: string[];
  limit: number;
  kind?: AtomKind;
}

export async function fetchAtomsByEpisode(
  engine: GraphEngineInstance,
  input: FetchAtomsByEpisodeInput,
): Promise<Atom[]> {
  if (input.episodeIds.length === 0) return [];
  const spec = engine.spec;
  if (!spec.episodesEnabled) return [];
  const atomTable = spec.atomTableName ?? 'Atom';
  const conn = engine.getConnection();

  const where: string[] = ['ep.id IN $ids'];
  const params: Record<string, unknown> = { ids: input.episodeIds };
  if (input.kind) {
    where.push('a.kind = $kind');
    params.kind = input.kind;
  }

  const query = `
    MATCH (a:${atomTable})-[:IN_EPISODE]->(ep:Episode)
    WHERE ${where.join(' AND ')}
    RETURN a.id AS id, a.content AS content, a.kind AS kind, a.salience AS salience,
           a.created_at AS created_at, a.last_accessed AS last_accessed,
           a.access_count AS access_count, a.source_instance AS source_instance,
           a.cwd AS cwd, a.source_kind AS source_kind,
           a.tier AS tier, a.extracted AS extracted,
           a.superseded_by AS superseded_by, a.foreign_episode AS foreign_episode
    ORDER BY a.created_at ASC
    LIMIT $limit
  `;
  params.limit = input.limit;
  const ps = await conn.prepare(query);
  const result = await conn.execute(ps, params as never);
  const rows = await firstResult(result).getAll() as Array<Record<string, unknown>>;
  return rows.map(rowToAtom);
}

// ─── spreadActivation ───────────────────────────────────────────────────────

export interface ActivationSeed {
  entityId: string;
  score: number;
}

export interface ActivationResult {
  entityId: string;
  score: number;
}

export interface SpreadActivationInput {
  seeds: ActivationSeed[];
  hops: 1 | 2;
  decay?: number;              // per-hop multiplier, default 0.5
  associationKinds?: string[]; // default: all declared, weighted only
  topK?: number;               // cap output length
}

/**
 * Spread activation from seed entities over ASSOCIATED-style edges. Each hop
 * multiplies propagated weight by `decay`. Edge weights are normalized via
 * `w / (w + 3)` so a brand-new edge (w=1) contributes 0.25, a heavy edge
 * (w=10) contributes ~0.77. Returns entities sorted by final score.
 */
export async function spreadActivation(
  engine: GraphEngineInstance,
  input: SpreadActivationInput,
): Promise<ActivationResult[]> {
  const spec = engine.spec;
  const entityTable = spec.entityTableName ?? 'Entity';
  const kinds = input.associationKinds
    ?? spec.associationKinds.filter((a) => a.weighted).map((a) => a.name);
  if (kinds.length === 0 || input.seeds.length === 0) {
    return input.seeds.map((s) => ({ entityId: s.entityId, score: s.score }));
  }
  const decay = input.decay ?? 0.5;
  const topK = input.topK ?? 50;
  const conn = engine.getConnection();

  const activated = new Map<string, number>();
  for (const s of input.seeds) {
    activated.set(s.entityId, Math.max(activated.get(s.entityId) ?? 0, s.score));
  }

  // Helper: one hop expansion from the currently-activated set.
  const expandOnce = async (currentIds: string[]): Promise<Map<string, { src: string; w: number }[]>> => {
    // For each kind, UNION both directions. Produce rows { src, dst, weight }.
    const unions = kinds.map((k) => `
      MATCH (src:${entityTable})-[r:${k}]-(dst:${entityTable})
      WHERE src.id IN $ids
      RETURN src.id AS src, dst.id AS dst, coalesce(r.weight, 1) AS w
    `).join(' UNION ALL ');
    const ps = await conn.prepare(unions);
    const result = await conn.execute(ps, { ids: currentIds });
    const rows = await firstResult(result).getAll() as Array<{ src: string; dst: string; w: number | bigint }>;

    const byDst = new Map<string, { src: string; w: number }[]>();
    for (const r of rows) {
      if (r.src === r.dst) continue;
      const list = byDst.get(r.dst) ?? [];
      list.push({ src: r.src, w: Number(r.w) });
      byDst.set(r.dst, list);
    }
    return byDst;
  };

  const normalize = (w: number) => w / (w + 3);

  let frontier = [...activated.keys()];
  let currentDecay = decay;

  for (let hop = 0; hop < input.hops; hop++) {
    if (frontier.length === 0) break;
    const hopOut = await expandOnce(frontier);
    const next: Map<string, number> = new Map();
    for (const [dst, links] of hopOut) {
      let best = 0;
      for (const { src, w } of links) {
        const srcScore = activated.get(src) ?? 0;
        const contrib = srcScore * normalize(w) * currentDecay;
        if (contrib > best) best = contrib;
      }
      if (best > 0) next.set(dst, best);
    }
    // Merge: keep max of existing vs newly propagated.
    for (const [id, score] of next) {
      activated.set(id, Math.max(activated.get(id) ?? 0, score));
    }
    frontier = [...next.keys()];
    currentDecay *= decay;
  }

  const results: ActivationResult[] = [...activated.entries()]
    .map(([entityId, score]) => ({ entityId, score }))
    .sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function rowToAtom(row: Record<string, unknown>): Atom {
  return {
    id: row.id as string,
    content: row.content as string,
    kind: row.kind as AtomKind,
    salience: (row.salience as Salience) ?? 'normal',
    created_at: row.created_at as string,
    last_accessed: row.last_accessed as string,
    access_count: Number(row.access_count ?? 0),
    source_instance: row.source_instance as string,
    cwd: (row.cwd as string) ?? null,
    source_kind: (row.source_kind as Atom['source_kind']) ?? 'consolidate',
    tier: (row.tier as AtomTier) ?? undefined,
    extracted: Boolean(row.extracted ?? false),
    superseded_by: (row.superseded_by as string) || null,
    foreign_episode: (row.foreign_episode as string) || null,
  };
}

type KuzuQueryResult = Awaited<ReturnType<Conn['execute']>>;

function firstResult(r: KuzuQueryResult): Exclude<KuzuQueryResult, unknown[]> {
  return (Array.isArray(r) ? r[0] : r) as Exclude<KuzuQueryResult, unknown[]>;
}
