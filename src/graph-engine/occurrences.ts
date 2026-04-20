// ─── Occurrence + association edge helpers ──────────────────────────────────
// Idempotent MENTIONS (Atom → Entity) and CO_OCCURS (Entity ↔ Entity) writes.
// Caller must hold the write lock.

import kuzu from 'kuzu';
import type { SchemaSpec } from './types.js';

type Conn = InstanceType<typeof kuzu.Connection>;

/**
 * Create a single MENTIONS-style occurrence edge from atomId → entityId.
 * Idempotent: no-op if the edge already exists. Returns true if a new edge was
 * created (useful for gating CO_OCCURS weight bumps).
 */
export async function createOccurrence(
  conn: Conn,
  spec: SchemaSpec,
  occurrenceKind: string,
  atomId: string,
  entityId: string,
  prominence: number,
): Promise<boolean> {
  const atomTable = spec.atomTableName ?? 'Atom';
  const entityTable = spec.entityTableName ?? 'Entity';

  // Check for existing edge
  const checkPs = await conn.prepare(`
    MATCH (a:${atomTable} {id: $aid})-[r:${occurrenceKind}]->(e:${entityTable} {id: $eid})
    RETURN count(r) AS c
  `);
  const check = await conn.execute(checkPs, { aid: atomId, eid: entityId });
  const checkRows = await firstResult(check).getAll() as Array<{ c: number | bigint }>;
  if (Number(checkRows[0]?.c ?? 0) > 0) return false;

  // Only the first declared occurrence kind carries prominence today.
  const occDef = spec.occurrenceKinds.find((o) => o.name === occurrenceKind);
  const withProm = occDef?.hasProminence ?? false;
  const createCypher = withProm
    ? `MATCH (a:${atomTable} {id: $aid}), (e:${entityTable} {id: $eid})
       CREATE (a)-[:${occurrenceKind} {prominence: $prom, created_at: $now}]->(e)`
    : `MATCH (a:${atomTable} {id: $aid}), (e:${entityTable} {id: $eid})
       CREATE (a)-[:${occurrenceKind} {created_at: $now}]->(e)`;

  const createPs = await conn.prepare(createCypher);
  const params: Record<string, unknown> = {
    aid: atomId,
    eid: entityId,
    now: new Date().toISOString(),
  };
  if (withProm) params.prom = prominence;
  await conn.execute(createPs, params as never);
  return true;
}

/**
 * Bump (or create) a CO_OCCURS-style association between two entities.
 * Canonicalizes direction by id order so there's only one edge per pair.
 * Returns the new weight.
 */
export async function bumpAssociation(
  conn: Conn,
  spec: SchemaSpec,
  associationKind: string,
  entityA: string,
  entityB: string,
): Promise<number> {
  if (entityA === entityB) return 0;

  // Canonicalize: always edge (min) → (max) so we don't double-count pairs.
  const [fromId, toId] = [entityA, entityB].sort();
  const entityTable = spec.entityTableName ?? 'Entity';

  const assocDef = spec.associationKinds.find((a) => a.name === associationKind);
  const weighted = assocDef?.weighted ?? false;

  if (!weighted) {
    // Create if absent, otherwise no-op.
    const checkPs = await conn.prepare(`
      MATCH (a:${entityTable} {id: $a})-[r:${associationKind}]->(b:${entityTable} {id: $b})
      RETURN count(r) AS c
    `);
    const c = await conn.execute(checkPs, { a: fromId, b: toId });
    const rows = await firstResult(c).getAll() as Array<{ c: number | bigint }>;
    if (Number(rows[0]?.c ?? 0) > 0) return 0;
    const createPs = await conn.prepare(`
      MATCH (a:${entityTable} {id: $a}), (b:${entityTable} {id: $b})
      CREATE (a)-[:${associationKind}]->(b)
    `);
    await conn.execute(createPs, { a: fromId, b: toId });
    return 0;
  }

  // Weighted: read current weight, +1, write back (or create fresh).
  const readPs = await conn.prepare(`
    MATCH (a:${entityTable} {id: $a})-[r:${associationKind}]->(b:${entityTable} {id: $b})
    RETURN r.weight AS w
  `);
  const read = await conn.execute(readPs, { a: fromId, b: toId });
  const rows = await firstResult(read).getAll() as Array<{ w: number | bigint }>;
  const now = new Date().toISOString();

  if (rows.length === 0) {
    const createPs = await conn.prepare(`
      MATCH (a:${entityTable} {id: $a}), (b:${entityTable} {id: $b})
      CREATE (a)-[:${associationKind} {weight: 1, last_reinforced: $now}]->(b)
    `);
    await conn.execute(createPs, { a: fromId, b: toId, now });
    return 1;
  }

  const next = Number(rows[0]!.w) + 1;
  const updatePs = await conn.prepare(`
    MATCH (a:${entityTable} {id: $a})-[r:${associationKind}]->(b:${entityTable} {id: $b})
    SET r.weight = $w, r.last_reinforced = $now
  `);
  await conn.execute(updatePs, { a: fromId, b: toId, w: next, now });
  return next;
}

/** Mark an atom as extracted=true. */
export async function markAtomExtracted(
  conn: Conn,
  spec: SchemaSpec,
  atomId: string,
): Promise<void> {
  const atomTable = spec.atomTableName ?? 'Atom';
  const ps = await conn.prepare(`
    MATCH (a:${atomTable} {id: $id}) SET a.extracted = true
  `);
  await conn.execute(ps, { id: atomId });
}

/** Load an atom by id. Returns null if not found. */
export async function fetchAtomById(
  conn: Conn,
  spec: SchemaSpec,
  atomId: string,
): Promise<{ id: string; content: string; cwd: string; source_instance: string; extracted: boolean } | null> {
  const atomTable = spec.atomTableName ?? 'Atom';
  const ps = await conn.prepare(`
    MATCH (a:${atomTable} {id: $id})
    RETURN a.id AS id, a.content AS content, a.cwd AS cwd,
           a.source_instance AS si, a.extracted AS extracted
    LIMIT 1
  `);
  const result = await conn.execute(ps, { id: atomId });
  const rows = await firstResult(result).getAll() as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    id: r.id as string,
    content: r.content as string,
    cwd: (r.cwd as string) ?? '',
    source_instance: r.si as string,
    extracted: Boolean(r.extracted),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type KuzuQueryResult = Awaited<ReturnType<Conn['execute']>>;

function firstResult(r: KuzuQueryResult): Exclude<KuzuQueryResult, unknown[]> {
  return (Array.isArray(r) ? r[0] : r) as Exclude<KuzuQueryResult, unknown[]>;
}
