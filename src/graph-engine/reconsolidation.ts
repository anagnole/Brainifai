// ─── Reconsolidation ────────────────────────────────────────────────────────
// Every read that surfaces an atom bumps its `last_accessed` and `access_count`.
// Optionally promotes tier (cold → warm → hot) when `agingEnabled`.
// "Reinforcement" between retrieved entities strengthens their associations.
//
// All functions must be called with the write lock held when they mutate,
// OR wrapped in `withLock` by the caller.

import kuzu from 'kuzu';
import type { GraphEngineInstance } from './instance.js';
import { bumpAssociation } from './occurrences.js';
import { withLock } from './lock.js';

type Conn = InstanceType<typeof kuzu.Connection>;

export interface ReconsolidateOptions {
  /** Weight of the read (0..1). Affects tier promotion aggressiveness. */
  weight?: number;
  /** When true, skip tier promotion even if agingEnabled. Default false. */
  noTierPromote?: boolean;
}

/**
 * Bump reconsolidation signals on a set of atoms:
 *   - last_accessed = now
 *   - access_count += 1
 *   - tier: cold → warm if weight ≥ 0.3; warm → hot if weight ≥ 0.5
 *
 * Does its own locking.
 */
export async function bumpReconsolidation(
  engine: GraphEngineInstance,
  atomIds: string[],
  opts: ReconsolidateOptions = {},
): Promise<void> {
  if (atomIds.length === 0) return;
  const weight = opts.weight ?? 1.0;
  const spec = engine.spec;
  const atomTable = spec.atomTableName ?? 'Atom';
  const now = new Date().toISOString();

  await withLock(engine.lockPath, async () => {
    const conn = engine.getConnection();

    // Kuzu doesn't support `x = x + 1` — batch-read, then batch-write.
    const readPs = await conn.prepare(`
      MATCH (a:${atomTable}) WHERE a.id IN $ids
      RETURN a.id AS id, a.access_count AS ac, a.tier AS tier
    `);
    const readResult = await conn.execute(readPs, { ids: atomIds });
    const rows = await firstResult(readResult).getAll() as Array<{
      id: string; ac: number | bigint; tier?: string;
    }>;

    for (const row of rows) {
      const nextCount = Number(row.ac) + 1;
      let nextTier = row.tier;
      if (spec.agingEnabled && !opts.noTierPromote) {
        if (row.tier === 'cold' && weight >= 0.3) nextTier = 'warm';
        else if (row.tier === 'warm' && weight >= 0.5) nextTier = 'hot';
      }

      if (spec.agingEnabled && nextTier !== row.tier && nextTier) {
        const ps = await conn.prepare(`
          MATCH (a:${atomTable} {id: $id})
          SET a.last_accessed = $now, a.access_count = $ac, a.tier = $tier
        `);
        await conn.execute(ps, { id: row.id, now, ac: nextCount, tier: nextTier });
      } else {
        const ps = await conn.prepare(`
          MATCH (a:${atomTable} {id: $id})
          SET a.last_accessed = $now, a.access_count = $ac
        `);
        await conn.execute(ps, { id: row.id, now, ac: nextCount });
      }
    }
  });
}

/**
 * For each retrieved atom, bump the pairwise association weight between
 * entities it MENTIONS. Models "thinking together reinforces."
 * No-op if the spec's `retrievalCoActivationEnabled` is false.
 */
export async function reinforceCoOccurrence(
  engine: GraphEngineInstance,
  atomIds: string[],
  opts: { associationKind?: string; occurrenceKind?: string } = {},
): Promise<void> {
  if (atomIds.length === 0) return;
  if (!engine.spec.retrievalCoActivationEnabled) return;

  const spec = engine.spec;
  const atomTable = spec.atomTableName ?? 'Atom';
  const entityTable = spec.entityTableName ?? 'Entity';
  const occKind = opts.occurrenceKind ?? spec.occurrenceKinds[0]?.name ?? 'MENTIONS';
  const assocKind = opts.associationKind ?? spec.associationKinds[0]?.name ?? 'ASSOCIATED';

  await withLock(engine.lockPath, async () => {
    const conn = engine.getConnection();

    // For each atom, gather the entity ids it mentions, then pair-up.
    for (const atomId of atomIds) {
      const ps = await conn.prepare(`
        MATCH (a:${atomTable} {id: $aid})-[:${occKind}]->(e:${entityTable})
        RETURN e.id AS id
      `);
      const result = await conn.execute(ps, { aid: atomId });
      const rows = await firstResult(result).getAll() as Array<{ id: string }>;
      const ids = rows.map((r) => r.id);

      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          await bumpAssociation(conn, spec, assocKind, ids[i]!, ids[j]!);
        }
      }
    }
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type KuzuQueryResult = Awaited<ReturnType<Conn['execute']>>;

function firstResult(r: KuzuQueryResult): Exclude<KuzuQueryResult, unknown[]> {
  return (Array.isArray(r) ? r[0] : r) as Exclude<KuzuQueryResult, unknown[]>;
}
