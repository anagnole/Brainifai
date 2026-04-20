// ─── Vector search helpers ──────────────────────────────────────────────────
// Search over stored embeddings. Prefers Kuzu's native vector index when
// available; falls back to client-side cosine otherwise. Caller passes a
// pre-computed query vector (see embedding.ts).
//
// This module is pure read — no writes, no lock required.

import kuzu from 'kuzu';
import { cosine } from './embedding.js';
import type { GraphEngineInstance } from './instance.js';
import type { Entity } from './types.js';
import { logger } from '../shared/logger.js';

type Conn = InstanceType<typeof kuzu.Connection>;

// ─── Public: search entities by vector ──────────────────────────────────────

export interface VectorSearchHit<T> {
  item: T;
  distance: number;   // cosine distance in [0, 2]; smaller = more similar
  similarity: number; // cosine similarity in [-1, 1]; larger = more similar
}

/**
 * Return the top-k entities by cosine similarity to `queryVec`. Tries Kuzu's
 * native vector index first; falls back to a JS cosine scan if the index is
 * missing or unavailable.
 */
export async function vectorSearchEntities(
  engine: GraphEngineInstance,
  queryVec: number[],
  k: number = 10,
): Promise<VectorSearchHit<Entity>[]> {
  const spec = engine.spec;
  if (!spec.embeddingsEnabled) return [];
  const entityTable = spec.entityTableName ?? 'Entity';

  // Try native vector index — Kuzu 0.11+ has `QUERY_VECTOR_INDEX` via the
  // `vector` extension. If it's unavailable or the index doesn't exist, fall
  // back to a full-scan cosine.
  try {
    return await nativeVectorSearch<Entity>(
      engine.getConnection(),
      entityTable,
      `${entityTable.toLowerCase()}_emb_idx`,
      queryVec,
      k,
      (row) => entityRow(row),
    );
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'Native vector index unavailable, falling back to cosine scan');
    return cosineScanEntities(engine, queryVec, k);
  }
}

/**
 * Return the top-k atoms by cosine similarity to `queryVec`. Same fallback
 * strategy as entities.
 */
export async function vectorSearchAtoms(
  engine: GraphEngineInstance,
  queryVec: number[],
  k: number = 10,
): Promise<VectorSearchHit<{ id: string; content: string; embedding: number[] | null }>[]> {
  const spec = engine.spec;
  if (!spec.embeddingsEnabled) return [];
  const atomTable = spec.atomTableName ?? 'Atom';

  try {
    return await nativeVectorSearch(
      engine.getConnection(),
      atomTable,
      `${atomTable.toLowerCase()}_emb_idx`,
      queryVec,
      k,
      (row) => ({
        id: row.id as string,
        content: row.content as string,
        embedding: (row.embedding as number[]) ?? null,
      }),
    );
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'Native atom vector index unavailable, using cosine scan');
    return cosineScanAtoms(engine, queryVec, k);
  }
}

// ─── Native Kuzu vector index ───────────────────────────────────────────────

async function nativeVectorSearch<T>(
  conn: Conn,
  table: string,
  indexName: string,
  queryVec: number[],
  k: number,
  mapRow: (row: Record<string, unknown>) => T,
): Promise<VectorSearchHit<T>[]> {
  const ps = await conn.prepare(`
    CALL QUERY_VECTOR_INDEX('${table}', '${indexName}', $q, $k)
    RETURN node.*, distance
    ORDER BY distance ASC
  `);
  const result = await conn.execute(ps, { q: queryVec, k });
  const rows = await firstResult(result).getAll() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const distance = Number(r.distance ?? 0);
    return { item: mapRow(r), distance, similarity: 1 - distance };
  });
}

// ─── Client-side cosine fallback ────────────────────────────────────────────
// Fetch all embeddings from the target table, rank in JS. Fine up to ~10K
// rows; past that, we'd switch to a proper index.

async function cosineScanEntities(
  engine: GraphEngineInstance,
  queryVec: number[],
  k: number,
): Promise<VectorSearchHit<Entity>[]> {
  const conn = engine.getConnection();
  const entityTable = engine.spec.entityTableName ?? 'Entity';

  const ps = await conn.prepare(`
    MATCH (e:${entityTable})
    WHERE e.embedding IS NOT NULL
    RETURN e.id AS id, e.name AS name, e.type AS type,
           e.first_seen AS first_seen, e.last_seen AS last_seen,
           e.mention_count AS mention_count, e.aliases AS aliases, e.status AS status,
           e.embedding AS embedding
  `);
  const result = await conn.execute(ps, {});
  const rows = await firstResult(result).getAll() as Array<Record<string, unknown>>;

  const hits: VectorSearchHit<Entity>[] = rows.map((r) => {
    const emb = (r.embedding as number[] | null) ?? [];
    const sim = emb.length === queryVec.length ? cosine(queryVec, emb) : 0;
    return { item: entityRow(r), distance: 1 - sim, similarity: sim };
  });

  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, k);
}

async function cosineScanAtoms(
  engine: GraphEngineInstance,
  queryVec: number[],
  k: number,
): Promise<VectorSearchHit<{ id: string; content: string; embedding: number[] | null }>[]> {
  const conn = engine.getConnection();
  const atomTable = engine.spec.atomTableName ?? 'Atom';

  const ps = await conn.prepare(`
    MATCH (a:${atomTable})
    WHERE a.embedding IS NOT NULL
    RETURN a.id AS id, a.content AS content, a.embedding AS embedding
  `);
  const result = await conn.execute(ps, {});
  const rows = await firstResult(result).getAll() as Array<Record<string, unknown>>;

  const hits = rows.map((r) => {
    const emb = (r.embedding as number[] | null) ?? [];
    const sim = emb.length === queryVec.length ? cosine(queryVec, emb) : 0;
    return {
      item: {
        id: r.id as string,
        content: r.content as string,
        embedding: emb,
      },
      distance: 1 - sim,
      similarity: sim,
    };
  });
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, k);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function entityRow(row: Record<string, unknown>): Entity {
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

type KuzuQueryResult = Awaited<ReturnType<Conn['execute']>>;

function firstResult(r: KuzuQueryResult): Exclude<KuzuQueryResult, unknown[]> {
  return (Array.isArray(r) ? r[0] : r) as Exclude<KuzuQueryResult, unknown[]>;
}
