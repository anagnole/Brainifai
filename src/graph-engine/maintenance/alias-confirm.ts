// ─── alias-confirm maintenance pass ─────────────────────────────────────────
// Walks ALIAS_OF edges with status='suspected', asks the LLM whether the two
// entities are the same thing, and either:
//   - confirms (status='confirmed', rewires MENTIONS from→to, marks `from` merged), or
//   - rejects (deletes the edge).
//
// Holds the engine's write lock for each individual decision so other writes
// can interleave between aliases. Per-run limit keeps wall time bounded.

import type { GraphEngineInstance } from '../instance.js';
import type { MaintenancePass, PassStats } from './index.js';
import { withLock } from '../lock.js';
import { complete, extractJsonOr } from '../llm.js';
import { logger } from '../../shared/logger.js';

interface Config {
  /** Max aliases evaluated per run. Default 20. */
  limit?: number;
  /** Min entity mention_count required to bother confirming (filters fresh noise). */
  minMentionCount?: number;
  /** Skip if `from` entity is younger than this many minutes — likely still being filled in. */
  minAgeMinutes?: number;
  /** LLM model (override). */
  model?: string;
}

const DEFAULTS: Required<Pick<Config, 'limit' | 'minMentionCount' | 'minAgeMinutes'>> = {
  limit: 20,
  minMentionCount: 1,
  minAgeMinutes: 5,
};

interface SuspectedAliasRow {
  fromId: string;  fromName: string;  fromType: string;  fromMentions: number;
  toId: string;    toName: string;    toType: string;    toMentions: number;
  confidence: number;
  fromCreated: string;
}

interface ConfirmDecision {
  same: boolean;
  reason?: string;
}

export const aliasConfirmPass: MaintenancePass = {
  name: 'alias-confirm',
  cadence: 'weekly',

  async run(engine: GraphEngineInstance, rawConfig?: Record<string, unknown>): Promise<PassStats> {
    const cfg = { ...DEFAULTS, ...(rawConfig as Config | undefined) };
    const entityTable = engine.spec.entityTableName ?? 'Entity';
    const atomTable = engine.spec.atomTableName ?? 'Atom';

    // Read-only fetch outside the lock — we only acquire the lock when
    // committing each decision below.
    const candidates = await fetchSuspected(engine, entityTable, cfg);
    if (candidates.length === 0) {
      return { noop: true, evaluated: 0, confirmed: 0, rejected: 0 };
    }

    let confirmed = 0;
    let rejected = 0;
    let llmFailures = 0;

    for (const row of candidates) {
      let decision: ConfirmDecision;
      try {
        const samples = await fetchSampleAtoms(engine, atomTable, [row.fromId, row.toId]);
        decision = await askLlm(row, samples, cfg.model);
      } catch (err) {
        llmFailures++;
        logger.warn({ err, fromId: row.fromId, toId: row.toId }, 'alias-confirm: LLM failed');
        continue;
      }

      try {
        if (decision.same) {
          await withLock(engine.lockPath, () => collapseAlias(engine, entityTable, atomTable, row));
          confirmed++;
        } else {
          await withLock(engine.lockPath, () => rejectAlias(engine, entityTable, row));
          rejected++;
        }
      } catch (err) {
        logger.warn({ err, fromId: row.fromId, toId: row.toId }, 'alias-confirm: write failed');
      }
    }

    return {
      evaluated: candidates.length,
      confirmed,
      rejected,
      llmFailures,
      config: cfg,
    };
  },
};

// ─── Fetching candidates ────────────────────────────────────────────────────

async function fetchSuspected(
  engine: GraphEngineInstance,
  entityTable: string,
  cfg: Required<Pick<Config, 'limit' | 'minMentionCount' | 'minAgeMinutes'>>,
): Promise<SuspectedAliasRow[]> {
  const conn = engine.getConnection();
  const cutoff = new Date(Date.now() - cfg.minAgeMinutes * 60_000).toISOString();
  const ps = await conn.prepare(`
    MATCH (from:${entityTable})-[r:ALIAS_OF]->(to:${entityTable})
    WHERE r.status = 'suspected'
      AND from.mention_count >= $minMentions
      AND to.mention_count >= $minMentions
      AND from.first_seen <= $cutoff
    RETURN from.id AS fromId, from.name AS fromName, from.type AS fromType,
           from.mention_count AS fromMentions, from.first_seen AS fromCreated,
           to.id AS toId, to.name AS toName, to.type AS toType,
           to.mention_count AS toMentions,
           r.confidence AS confidence
    ORDER BY r.confidence DESC
    LIMIT $limit
  `);
  const r = await conn.execute(ps, {
    minMentions: cfg.minMentionCount,
    cutoff,
    limit: cfg.limit,
  } as never);
  const rows = await (Array.isArray(r) ? r[0] : r).getAll() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    fromId:       String(row.fromId),
    fromName:     String(row.fromName),
    fromType:     String(row.fromType),
    fromMentions: Number(row.fromMentions ?? 0),
    fromCreated:  String(row.fromCreated),
    toId:         String(row.toId),
    toName:       String(row.toName),
    toType:       String(row.toType),
    toMentions:   Number(row.toMentions ?? 0),
    confidence:   Number(row.confidence ?? 0),
  }));
}

async function fetchSampleAtoms(
  engine: GraphEngineInstance,
  atomTable: string,
  entityIds: string[],
): Promise<Map<string, string[]>> {
  const conn = engine.getConnection();
  const ps = await conn.prepare(`
    MATCH (a:${atomTable})-[:MENTIONS]->(e)
    WHERE e.id IN $ids
    RETURN e.id AS eid, a.content AS content
    LIMIT 12
  `);
  const r = await conn.execute(ps, { ids: entityIds } as never);
  const rows = await (Array.isArray(r) ? r[0] : r).getAll() as Array<{ eid: string; content: string }>;
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const arr = map.get(row.eid) ?? [];
    arr.push(row.content);
    map.set(row.eid, arr);
  }
  return map;
}

// ─── LLM judge ──────────────────────────────────────────────────────────────

async function askLlm(
  row: SuspectedAliasRow,
  samples: Map<string, string[]>,
  model?: string,
): Promise<ConfirmDecision> {
  const fromCtx = (samples.get(row.fromId) ?? []).slice(0, 3).map((s) => `  - ${truncate(s, 200)}`).join('\n');
  const toCtx   = (samples.get(row.toId)   ?? []).slice(0, 3).map((s) => `  - ${truncate(s, 200)}`).join('\n');
  const prompt = [
    'You are deciding if two extracted entities refer to the same real thing.',
    '',
    `Entity A: "${row.fromName}" (type: ${row.fromType}, mention count: ${row.fromMentions})`,
    fromCtx ? `Sample mentions of A:\n${fromCtx}` : '(no sample mentions for A)',
    '',
    `Entity B: "${row.toName}" (type: ${row.toType}, mention count: ${row.toMentions})`,
    toCtx ? `Sample mentions of B:\n${toCtx}` : '(no sample mentions for B)',
    '',
    'Reply with strict JSON only: {"same": true|false, "reason": "..."}',
    'Use "same": true ONLY if you are confident A and B refer to the same thing.',
    'When in doubt, say false.',
  ].join('\n');

  const text = await complete(prompt, { model, maxTokens: 200, timeoutMs: 20_000 });
  return extractJsonOr<ConfirmDecision>(text, { same: false, reason: 'unparseable' });
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// ─── Commit decisions ───────────────────────────────────────────────────────

export async function _collapseAliasForTesting(
  engine: GraphEngineInstance,
  entityTable: string,
  atomTable: string,
  row: SuspectedAliasRow,
): Promise<void> {
  return collapseAlias(engine, entityTable, atomTable, row);
}

export async function _rejectAliasForTesting(
  engine: GraphEngineInstance,
  entityTable: string,
  row: SuspectedAliasRow,
): Promise<void> {
  return rejectAlias(engine, entityTable, row);
}

export type _SuspectedAliasRowForTesting = SuspectedAliasRow;

async function collapseAlias(
  engine: GraphEngineInstance,
  entityTable: string,
  atomTable: string,
  row: SuspectedAliasRow,
): Promise<void> {
  const conn = engine.getConnection();

  // 1. Snapshot the (atomId, prominence, created_at) tuples that mention `from`,
  //    skipping atoms that already mention `to` (idempotency guard).
  const snapshotPs = await conn.prepare(`
    MATCH (a:${atomTable})-[r:MENTIONS]->(:${entityTable} {id: $fromId})
    WHERE NOT EXISTS { MATCH (a)-[:MENTIONS]->(:${entityTable} {id: $toId}) }
    RETURN a.id AS aid,
           coalesce(r.prominence, 0.5) AS prom,
           r.created_at AS createdAt
  `);
  const snapResult = await conn.execute(snapshotPs, { fromId: row.fromId, toId: row.toId } as never);
  const snapshots = await (Array.isArray(snapResult) ? snapResult[0] : snapResult).getAll() as Array<{
    aid: string; prom: number; createdAt: string;
  }>;

  // 2. Create the new edges from snapshot (one prepared statement, parameterized).
  if (snapshots.length > 0) {
    const createPs = await conn.prepare(`
      MATCH (a:${atomTable} {id: $aid}), (t:${entityTable} {id: $toId})
      CREATE (a)-[:MENTIONS {prominence: $prom, created_at: $createdAt}]->(t)
    `);
    for (const s of snapshots) {
      await conn.execute(createPs, {
        aid: s.aid, toId: row.toId, prom: s.prom, createdAt: s.createdAt,
      } as never);
    }
  }

  // 3. Drop all old MENTIONS edges from `from`.
  const dropMentionsPs = await conn.prepare(`
    MATCH (:${atomTable})-[r:MENTIONS]->(from:${entityTable} {id: $fromId})
    DELETE r
  `);
  await conn.execute(dropMentionsPs, { fromId: row.fromId } as never);

  // 4. Mark `from` as merged + bump `to.mention_count` and merge aliases.
  const mergePs = await conn.prepare(`
    MATCH (from:${entityTable} {id: $fromId}), (to:${entityTable} {id: $toId})
    SET from.status = 'merged',
        to.mention_count = to.mention_count + from.mention_count,
        to.aliases = to.aliases + from.aliases + [from.name],
        to.last_seen = CASE WHEN from.last_seen > to.last_seen
                            THEN from.last_seen ELSE to.last_seen END
  `);
  await conn.execute(mergePs, { fromId: row.fromId, toId: row.toId } as never);

  // 5. Update the ALIAS_OF edge to status='confirmed'.
  const setEdgePs = await conn.prepare(`
    MATCH (from:${entityTable} {id: $fromId})-[r:ALIAS_OF]->(to:${entityTable} {id: $toId})
    SET r.status = 'confirmed'
  `);
  await conn.execute(setEdgePs, { fromId: row.fromId, toId: row.toId } as never);
}

async function rejectAlias(
  engine: GraphEngineInstance,
  entityTable: string,
  row: SuspectedAliasRow,
): Promise<void> {
  const conn = engine.getConnection();
  const ps = await conn.prepare(`
    MATCH (from:${entityTable} {id: $fromId})-[r:ALIAS_OF]->(to:${entityTable} {id: $toId})
    DELETE r
  `);
  await conn.execute(ps, { fromId: row.fromId, toId: row.toId } as never);
}
