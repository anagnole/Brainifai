// ─── Entity CRUD helpers ────────────────────────────────────────────────────
// Small wrappers around Kuzu writes for Entity nodes + their engine-provided
// edges (ALIAS_OF, IS_A). Callers must hold the write lock.

import kuzu from 'kuzu';
import { ulid } from 'ulid';
import type { Entity, EntityType, SchemaSpec } from './types.js';

type Conn = InstanceType<typeof kuzu.Connection>;

export interface CreateEntityInput {
  name: string;
  type: EntityType;
  aliases?: string[];
}

export async function createEntity(
  conn: Conn,
  spec: SchemaSpec,
  input: CreateEntityInput,
): Promise<string> {
  const table = spec.entityTableName ?? 'Entity';
  const id = ulid();
  const now = new Date().toISOString();

  const ps = await conn.prepare(`
    CREATE (e:${table} {
      id: $id,
      name: $name,
      type: $type,
      first_seen: $now,
      last_seen: $now,
      mention_count: 0,
      aliases: $aliases,
      status: 'active'
    })
  `);
  await conn.execute(ps, {
    id,
    name: input.name,
    type: input.type,
    now,
    aliases: input.aliases ?? [],
  });
  return id;
}

/** Fetch an Entity by exact name match. Returns the first match or null. */
export async function findEntityByExactName(
  conn: Conn,
  spec: SchemaSpec,
  name: string,
): Promise<Entity | null> {
  const table = spec.entityTableName ?? 'Entity';
  const ps = await conn.prepare(`
    MATCH (e:${table} {name: $name})
    RETURN e.id AS id, e.name AS name, e.type AS type,
           e.first_seen AS first_seen, e.last_seen AS last_seen,
           e.mention_count AS mention_count, e.aliases AS aliases, e.status AS status
    LIMIT 1
  `);
  const result = await conn.execute(ps, { name });
  const rows = await firstResult(result).getAll() as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  return rowToEntity(rows[0]!);
}

/** Fetch entities whose name matches case-insensitively. */
export async function findEntitiesByNameCI(
  conn: Conn,
  spec: SchemaSpec,
  name: string,
  limit = 5,
): Promise<Entity[]> {
  const table = spec.entityTableName ?? 'Entity';
  const ps = await conn.prepare(`
    MATCH (e:${table})
    WHERE lower(e.name) = $name
    RETURN e.id AS id, e.name AS name, e.type AS type,
           e.first_seen AS first_seen, e.last_seen AS last_seen,
           e.mention_count AS mention_count, e.aliases AS aliases, e.status AS status
    LIMIT $limit
  `);
  const result = await conn.execute(ps, { name: name.toLowerCase(), limit });
  const rows = await firstResult(result).getAll() as Array<Record<string, unknown>>;
  return rows.map(rowToEntity);
}

/**
 * Fetch entities whose name contains the given token (case-insensitive). Used
 * as a last-resort fallback when FTS + exact + CI all miss — e.g. cue "5k"
 * should find entity "5k run". Skip queries shorter than 3 chars to avoid
 * returning half the graph.
 */
export async function findEntitiesByPartialName(
  conn: Conn,
  spec: SchemaSpec,
  name: string,
  limit = 10,
): Promise<Entity[]> {
  if (name.length < 2) return [];
  const table = spec.entityTableName ?? 'Entity';
  const ps = await conn.prepare(`
    MATCH (e:${table})
    WHERE lower(e.name) CONTAINS $needle
    RETURN e.id AS id, e.name AS name, e.type AS type,
           e.first_seen AS first_seen, e.last_seen AS last_seen,
           e.mention_count AS mention_count, e.aliases AS aliases, e.status AS status
    LIMIT $limit
  `);
  const result = await conn.execute(ps, { needle: name.toLowerCase(), limit });
  const rows = await firstResult(result).getAll() as Array<Record<string, unknown>>;
  return rows.map(rowToEntity);
}

/**
 * Full cue-to-seeds resolution: tries FTS → exact → CI → per-token CI →
 * partial match, in that order. Deduplicates by id. Used by the general
 * instance's associate() and recall_episode() so both take the same path.
 */
export async function resolveCueToSeeds(
  conn: Conn,
  spec: SchemaSpec,
  cue: string,
  maxSeeds = 10,
): Promise<Entity[]> {
  const seen = new Map<string, Entity>();
  const add = (arr: Entity[]) => { for (const e of arr) if (!seen.has(e.id)) seen.set(e.id, e); };

  // 1. FTS
  try { add(await searchEntitiesByName(conn, spec, cue, maxSeeds)); } catch { /* swallow */ }

  // 2. Exact name
  const exact = await findEntityByExactName(conn, spec, cue);
  if (exact) add([exact]);

  // 3. Case-insensitive whole-cue match
  add(await findEntitiesByNameCI(conn, spec, cue, maxSeeds));

  // 4. Token-wise CI match (helps multi-word cues)
  const tokens = cue.split(/\s+/).filter((t) => t.length >= 3);
  for (const t of tokens) {
    add(await findEntitiesByNameCI(conn, spec, t, maxSeeds));
  }

  // 5. Partial match — always run, so "Anna" (an exact CI hit) also pulls in
  //    "Anna Smith", and short cues like "5k" pull in "5k run".
  add(await findEntitiesByPartialName(conn, spec, cue, maxSeeds));
  for (const t of tokens) add(await findEntitiesByPartialName(conn, spec, t, maxSeeds));

  return [...seen.values()].slice(0, maxSeeds);
}

/** Bump mention_count by 1 and refresh last_seen. */
export async function bumpMention(
  conn: Conn,
  spec: SchemaSpec,
  entityId: string,
): Promise<void> {
  const table = spec.entityTableName ?? 'Entity';
  const now = new Date().toISOString();

  // Kuzu doesn't support `x = x + 1` in SET; need a 2-step read-then-write.
  const readPs = await conn.prepare(`
    MATCH (e:${table} {id: $id}) RETURN e.mention_count AS mc
  `);
  const readResult = await conn.execute(readPs, { id: entityId });
  const rows = await firstResult(readResult).getAll() as Array<{ mc: number | bigint }>;
  if (rows.length === 0) return;
  const current = rows[0]!.mc;
  const next = Number(current) + 1;

  const writePs = await conn.prepare(`
    MATCH (e:${table} {id: $id})
    SET e.mention_count = $next, e.last_seen = $now
  `);
  await conn.execute(writePs, { id: entityId, next, now });
}

/** Create an ALIAS_OF edge with status='suspected' and a confidence score. */
export async function createSuspectedAlias(
  conn: Conn,
  spec: SchemaSpec,
  fromEntityId: string,
  toEntityId: string,
  confidence: number,
): Promise<void> {
  const table = spec.entityTableName ?? 'Entity';
  const ps = await conn.prepare(`
    MATCH (from:${table} {id: $fid}), (to:${table} {id: $tid})
    CREATE (from)-[:ALIAS_OF {confidence: $conf, status: 'suspected'}]->(to)
  `);
  await conn.execute(ps, { fid: fromEntityId, tid: toEntityId, conf: confidence });
}

/**
 * FTS candidate lookup. Returns up to `k` entities whose name matches the
 * query, ordered by FTS score. Swallows errors (e.g. missing FTS index on
 * fresh graph) and returns [].
 */
export async function searchEntitiesByName(
  conn: Conn,
  spec: SchemaSpec,
  query: string,
  k: number,
): Promise<Entity[]> {
  const table = spec.entityTableName ?? 'Entity';
  try {
    const ps = await conn.prepare(`
      CALL QUERY_FTS_INDEX('${table}', 'entity_fts', $q, top_k := $k)
      RETURN node.id AS id, node.name AS name, node.type AS type,
             node.first_seen AS first_seen, node.last_seen AS last_seen,
             node.mention_count AS mention_count,
             node.aliases AS aliases, node.status AS status,
             score
      ORDER BY score DESC
    `);
    const result = await conn.execute(ps, { q: query, k });
    const rows = await firstResult(result).getAll() as Array<Record<string, unknown>>;
    return rows.map(rowToEntity);
  } catch {
    return [];
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type KuzuQueryResult = Awaited<ReturnType<Conn['execute']>>;

function firstResult(r: KuzuQueryResult): Exclude<KuzuQueryResult, unknown[]> {
  return (Array.isArray(r) ? r[0] : r) as Exclude<KuzuQueryResult, unknown[]>;
}

function rowToEntity(row: Record<string, unknown>): Entity {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as string,
    first_seen: row.first_seen as string,
    last_seen: row.last_seen as string,
    mention_count: Number(row.mention_count ?? 0),
    aliases: (row.aliases as string[]) ?? [],
    status: (row.status as Entity['status']) ?? 'active',
  };
}
