// ─── general instance — 4 brain-inspired retrieval primitives ──────────────
// These are thin wrappers over engine primitives (write-path, reads,
// reconsolidation, resolver) shaped to match the context-building design
// (docs/design/context-building.md).

import type { GraphEngineInstance } from '../../graph-engine/instance.js';
import { writeAtom } from '../../graph-engine/write-path.js';
import {
  fetchAtomsByOrder,
  fetchAtomsByEpisode,
  fetchMentioningAtoms,
  spreadActivation,
  type ActivationResult,
  type MentioningAtom,
} from '../../graph-engine/reads.js';
import {
  bumpReconsolidation,
  reinforceCoOccurrence,
} from '../../graph-engine/reconsolidation.js';
import { resolveCueToSeeds } from '../../graph-engine/entities.js';
import type { Atom, AtomKind, Salience } from '../../graph-engine/types.js';

// ─── Working memory ─────────────────────────────────────────────────────────

export interface WorkingMemoryInput {
  scope?: 'global' | 'here';
  /** Max items to return. Default 15, capped at 50. */
  limit?: number;
  /** When scope='here', which cwd to filter by (defaults to process.cwd()). */
  cwd?: string;
}

/**
 * Return the most-recently-accessed atoms. No cue; just "what was I doing."
 * Bumps reconsolidation with a light weight (0.3).
 */
export async function working_memory(
  engine: GraphEngineInstance,
  input: WorkingMemoryInput = {},
): Promise<Atom[]> {
  const limit = Math.min(input.limit ?? 15, 50);
  const cwd = input.scope === 'here' ? (input.cwd ?? process.cwd()) : undefined;

  const atoms = await fetchAtomsByOrder(engine, {
    orderBy: 'last_accessed',
    direction: 'desc',
    limit,
    filter: cwd ? { cwd, excludeSuperseded: true } : { excludeSuperseded: true },
  });

  if (atoms.length > 0) {
    await bumpReconsolidation(engine, atoms.map((a) => a.id), { weight: 0.3 });
  }
  return atoms;
}

// ─── Associate (spreading activation) ───────────────────────────────────────

export interface AssociateInput {
  cue: string;
  limit?: number;
}

export interface AssociateHit {
  atom: Atom;
  score: number;
  mention_score: number;
  matched_entities: number;
}

/**
 * Spreading activation from the cue. Resolves cue → entities via FTS, spreads
 * over ASSOCIATED edges (2 hops), then ranks atoms that MENTION activated
 * entities by score * prominence * recency. Bumps reconsolidation (full
 * weight) and reinforces CO_OCCURS between retrieved atoms' entities.
 */
export async function associate(
  engine: GraphEngineInstance,
  input: AssociateInput,
): Promise<AssociateHit[]> {
  const limit = Math.min(input.limit ?? 10, 30);
  const conn = engine.getConnection();

  // 1. Cue → seed entities via the shared resolution chain (FTS → exact →
  //    CI → tokens → partial). Robust against FTS misses and capitalization
  //    mismatches.
  const seedEntities = await resolveCueToSeeds(conn, engine.spec, input.cue, 5);
  if (seedEntities.length === 0) return [];

  // 2. Spread activation 2 hops
  const activated: ActivationResult[] = await spreadActivation(engine, {
    seeds: seedEntities.map((e) => ({ entityId: e.id, score: 1.0 })),
    hops: 2,
    decay: 0.5,
    topK: 30,
  });
  if (activated.length === 0) return [];

  const entityScore = new Map<string, number>(activated.map((a) => [a.entityId, a.score]));

  // 3. Atoms that mention activated entities (over-fetch; rerank below)
  const atoms: MentioningAtom[] = await fetchMentioningAtoms(engine, {
    entityIds: activated.map((a) => a.entityId),
    limit: limit * 4,
  });
  if (atoms.length === 0) return [];

  // 4. Pull the actual MENTIONS edges so we can score each atom by
  //    sum(prominence × entity-activation) — not just flat mention sum.
  //    That way atoms whose mentioned entities are strongly activated
  //    (direct seed mentions) outrank atoms that only reach activated
  //    entities via 2-hop neighbors.
  const atomIds = atoms.map((a) => a.id);
  const mentPs = await conn.prepare(`
    MATCH (a:Atom)-[r:MENTIONS]->(e:Entity)
    WHERE a.id IN $aids AND e.id IN $eids
    RETURN a.id AS aid, e.id AS eid, coalesce(r.prominence, 0.5) AS prom
  `);
  const mentResult = await conn.execute(mentPs, {
    aids: atomIds,
    eids: activated.map((a) => a.entityId),
  });
  const mentRows = await (Array.isArray(mentResult) ? mentResult[0]! : mentResult).getAll() as Array<{
    aid: string; eid: string; prom: number;
  }>;
  const activationWeightedMention = new Map<string, number>();
  for (const m of mentRows) {
    const activation = entityScore.get(m.eid) ?? 0;
    const contribution = (m.prom ?? 0.5) * activation;
    activationWeightedMention.set(m.aid, (activationWeightedMention.get(m.aid) ?? 0) + contribution);
  }

  // 5. Final ranking: weighted mention × recency × salience × tier
  const ranked = atoms.map<AssociateHit>((a) => {
    const weighted = activationWeightedMention.get(a.id) ?? 0;
    const recencyDecay = recencyFactor(a.last_accessed);
    const sal = salienceWeight(a.salience);
    const tierW = tierWeight(a.tier ?? 'hot');
    const score = weighted * recencyDecay * sal * tierW;
    return { atom: a, score, mention_score: weighted, matched_entities: a.matched_entities };
  }).sort((x, y) => y.score - x.score).slice(0, limit);

  // 5. Reconsolidate
  if (ranked.length > 0) {
    const ids = ranked.map((h) => h.atom.id);
    await bumpReconsolidation(engine, ids, { weight: 1.0 });
    await reinforceCoOccurrence(engine, ids);
  }
  return ranked;
}

// ─── Recall episode ─────────────────────────────────────────────────────────

export interface RecallEpisodeInput {
  cue?: string;
  /** ISO range "from/to" or loose hints like "last week" — parsed by caller. */
  when?: { from?: string; to?: string };
  /** cwd filter. */
  where?: string;
  /** Atom kind filter. */
  kind?: AtomKind;
  limit?: number;
}

/**
 * Episodic recall. Filters by time (episode.start_time), cwd, and kind. If a
 * cue is given, re-ranks the filtered atoms by activation-style scoring.
 */
export async function recall_episode(
  engine: GraphEngineInstance,
  input: RecallEpisodeInput,
): Promise<Atom[]> {
  const conn = engine.getConnection();
  const spec = engine.spec;
  const limit = Math.min(input.limit ?? 20, 50);

  // 1. Find matching episodes
  const whereClauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (input.when?.from) { whereClauses.push('ep.start_time >= $from'); params.from = input.when.from; }
  if (input.when?.to)   { whereClauses.push('ep.start_time <= $to');   params.to   = input.when.to;   }
  if (input.where)      { whereClauses.push('ep.cwd = $cwd');          params.cwd  = input.where;    }
  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const episodePs = await conn.prepare(`
    MATCH (ep:Episode) ${whereStr} RETURN ep.id AS id
  `);
  const episodeResult = await conn.execute(episodePs, params as never);
  const episodeRows = await (Array.isArray(episodeResult) ? episodeResult[0]! : episodeResult).getAll() as Array<{ id: string }>;
  const episodeIds = episodeRows.map((r) => r.id);

  if (episodeIds.length === 0) return [];

  // 2. Atoms in those episodes
  const atoms = await fetchAtomsByEpisode(engine, {
    episodeIds, limit: limit * 3, kind: input.kind,
  });
  if (atoms.length === 0) return [];

  // 3. Optional cue rerank — use the shared seed-resolution chain
  let ranked = atoms;
  if (input.cue) {
    const seedEntities = await resolveCueToSeeds(conn, spec, input.cue, 5);
    if (seedEntities.length > 0) {
      const activated = await spreadActivation(engine, {
        seeds: seedEntities.map((e) => ({ entityId: e.id, score: 1.0 })),
        hops: 1,
        decay: 0.5,
      });
      const scoreByEntity = new Map<string, number>(activated.map((a) => [a.entityId, a.score]));
      const atomIds = atoms.map((a) => a.id);

      // Pull MENTIONS edges for these atoms
      const mentPs = await conn.prepare(`
        MATCH (a:Atom)-[r:MENTIONS]->(e:Entity)
        WHERE a.id IN $aids
        RETURN a.id AS aid, e.id AS eid, r.prominence AS prom
      `);
      const mentResult = await conn.execute(mentPs, { aids: atomIds });
      const mentRows = await (Array.isArray(mentResult) ? mentResult[0]! : mentResult).getAll() as Array<{ aid: string; eid: string; prom: number }>;

      const atomCueScore = new Map<string, number>();
      for (const m of mentRows) {
        const s = (scoreByEntity.get(m.eid) ?? 0) * (m.prom ?? 0.5);
        atomCueScore.set(m.aid, (atomCueScore.get(m.aid) ?? 0) + s);
      }
      ranked = [...atoms].sort((x, y) =>
        (atomCueScore.get(y.id) ?? 0) - (atomCueScore.get(x.id) ?? 0),
      );
    }
  }

  ranked = ranked.slice(0, limit);
  if (ranked.length > 0) {
    await bumpReconsolidation(engine, ranked.map((a) => a.id), { weight: 0.8 });
  }
  return ranked;
}

// ─── Consolidate (write) ────────────────────────────────────────────────────

export interface ConsolidateInput {
  content: string;
  kind?: AtomKind;          // default 'observation'
  salience?: Salience;      // default 'normal'
  supersedes?: string | string[];
  source_instance?: string; // default 'general'
  cwd?: string;             // default process.cwd()
}

export interface ConsolidateResult {
  id: string;
  superseded: string[];
}

/**
 * Write a new Memory atom. Enqueues extraction. Supersedes accepts ids only
 * for now; cue-based supersedes lands when associate can be reused for lookup.
 */
export async function consolidate(
  engine: GraphEngineInstance,
  input: ConsolidateInput,
): Promise<ConsolidateResult> {
  const result = await writeAtom(engine, {
    content: input.content,
    kind: input.kind ?? 'observation',
    salience: input.salience ?? 'normal',
    supersedes: input.supersedes,
    context: {
      source_instance: input.source_instance ?? 'general',
      cwd: input.cwd ?? process.cwd(),
      source_kind: 'consolidate',
    },
  });
  return result;
}

// ─── Scoring helpers ────────────────────────────────────────────────────────

const RECENCY_HORIZON_DAYS = 90;

function recencyFactor(lastAccessed: string): number {
  const t = Date.parse(lastAccessed);
  if (isNaN(t)) return 0.5;
  const days = (Date.now() - t) / 86_400_000;
  if (days <= 0) return 1;
  return Math.max(0.1, 1 - days / RECENCY_HORIZON_DAYS);
}

function salienceWeight(s: Salience): number {
  return s === 'high' ? 1.25 : s === 'low' ? 0.6 : 1.0;
}

function tierWeight(tier: string): number {
  return tier === 'hot' ? 1.0 : tier === 'warm' ? 0.7 : 0.4;
}

