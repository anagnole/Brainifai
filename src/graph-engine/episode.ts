// ─── Episode CRUD ───────────────────────────────────────────────────────────
// Helpers for the Episode node (session grouping). Used by write-path.ts
// when linking atoms and by session-lifecycle orchestrators.
//
// Callers must hold the single-writer lock when mutating.

import kuzu from 'kuzu';
import { ulid } from 'ulid';

type Conn = InstanceType<typeof kuzu.Connection>;

export interface StartEpisodeInput {
  source_instance: string;
  cwd: string | null;
  message_count?: number;
}

/** Create a new open Episode row. Returns its id. */
export async function startEpisode(conn: Conn, input: StartEpisodeInput): Promise<string> {
  const id = ulid();
  const now = new Date().toISOString();
  const ps = await conn.prepare(`
    CREATE (e:Episode {
      id: $id,
      start_time: $start_time,
      end_time: '',
      source_instance: $source_instance,
      cwd: $cwd,
      summary_memory_id: '',
      message_count: $mc,
      closed: false
    })
  `);
  await conn.execute(ps, {
    id,
    start_time: now,
    source_instance: input.source_instance,
    cwd: input.cwd ?? '',
    mc: input.message_count ?? 0,
  });
  return id;
}

/** Mark an Episode closed and attach a session-summary memory id if any. */
export async function closeEpisode(
  conn: Conn,
  episodeId: string,
  summaryMemoryId?: string | null,
): Promise<void> {
  const end = new Date().toISOString();
  const ps = await conn.prepare(`
    MATCH (e:Episode {id: $id})
    SET e.end_time = $end_time, e.closed = true, e.summary_memory_id = $sum
  `);
  await conn.execute(ps, {
    id: episodeId,
    end_time: end,
    sum: summaryMemoryId ?? '',
  });
}

/** Return the most-recently started open episode matching (instance, cwd), or null. */
export async function findActiveEpisode(
  conn: Conn,
  source_instance: string,
  cwd: string | null,
): Promise<string | null> {
  const ps = await conn.prepare(`
    MATCH (e:Episode)
    WHERE e.closed = false
      AND e.source_instance = $si
      AND e.cwd = $cwd
    RETURN e.id AS id
    ORDER BY e.start_time DESC
    LIMIT 1
  `);
  const result = await conn.execute(ps, { si: source_instance, cwd: cwd ?? '' });
  const rows = await (Array.isArray(result) ? result[0]! : result).getAll() as Array<{ id: string }>;
  return rows.length > 0 ? rows[0]!.id : null;
}

/** Find an active episode; create one if none exists. Returns the id. */
export async function getOrCreateActiveEpisode(
  conn: Conn,
  input: StartEpisodeInput,
): Promise<string> {
  const existing = await findActiveEpisode(conn, input.source_instance, input.cwd);
  if (existing) return existing;
  return startEpisode(conn, input);
}
