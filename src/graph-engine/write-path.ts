// ─── Phase A: synchronous write path ────────────────────────────────────────
// writeAtom creates an Atom row, links it to an optional Episode, records any
// SUPERSEDES edges, and enqueues an ExtractionJob for Phase B. All within
// a single lock acquisition. Returns in single-digit ms.
//
// Structured mode (preExtracted entities) is accepted at the input level but
// the actual entity resolution is handled by the resolver in a later phase.
// For now, structured writes still enqueue a job so the worker can process
// them once resolver lands.

import kuzu from 'kuzu';
import type { KuzuValue } from 'kuzu';
import { ulid } from 'ulid';
import { withLock } from './lock.js';
import { enqueueJob } from './queue.js';
import { getOrCreateActiveEpisode } from './episode.js';
import { embed } from './embedding.js';
import { vectorSearchAtoms } from './vector.js';
import type { GraphEngineInstance } from './instance.js';
import type {
  WriteAtomInput,
  WriteAtomResult,
  Salience,
  SchemaSpec,
} from './types.js';

type Conn = InstanceType<typeof kuzu.Connection>;

/**
 * Write a single atom. Acquires the lock, creates the Atom node, links to the
 * active Episode (if episodesEnabled), adds SUPERSEDES edges (for atom ids
 * provided in `supersedes`), enqueues an ExtractionJob, returns.
 *
 * Latency target: <20ms text mode, <50ms structured.
 */
export async function writeAtom(
  engine: GraphEngineInstance,
  input: WriteAtomInput,
): Promise<WriteAtomResult> {
  return withLock(engine.lockPath, async () => {
    return writeAtomInner(engine, input);
  });
}

/**
 * Batch writer — one lock acquisition for N atoms. Each atom still enqueues
 * its own ExtractionJob so the worker can process them individually.
 */
export async function writeAtoms(
  engine: GraphEngineInstance,
  inputs: WriteAtomInput[],
): Promise<WriteAtomResult[]> {
  return withLock(engine.lockPath, async () => {
    const results: WriteAtomResult[] = [];
    for (const input of inputs) {
      results.push(await writeAtomInner(engine, input));
    }
    return results;
  });
}

// ─── Core implementation (lock-held) ────────────────────────────────────────

async function writeAtomInner(
  engine: GraphEngineInstance,
  input: WriteAtomInput,
): Promise<WriteAtomResult> {
  const conn = engine.getConnection();
  const spec = engine.spec;
  const atomTable = spec.atomTableName ?? 'Atom';

  const id = ulid();
  const now = new Date().toISOString();
  const salience: Salience = input.salience ?? 'normal';
  const sourceKind = input.context.source_kind ?? 'consolidate';
  const foreignEp = input.context.foreign_episode
    ? JSON.stringify(input.context.foreign_episode)
    : '';

  // 1. Create the Atom row
  await createAtom(conn, atomTable, spec, {
    id,
    content: input.content,
    kind: input.kind,
    salience,
    created_at: now,
    last_accessed: now,
    source_instance: input.context.source_instance,
    cwd: input.context.cwd ?? '',
    source_kind: sourceKind,
    foreign_episode: foreignEp,
  });

  // 2. Link to Episode if enabled and we have a local episode (not foreign)
  if (spec.episodesEnabled && !input.context.foreign_episode) {
    const episodeId = await getOrCreateActiveEpisode(conn, {
      source_instance: input.context.source_instance,
      cwd: input.context.cwd,
    });
    await linkInEpisode(conn, atomTable, id, episodeId);
  }

  // 3. Apply SUPERSEDES edges. `supersedes` accepts either explicit atom ids
  //    (ULIDs, 26 chars alphanumeric) or a free-text cue that we resolve to
  //    atoms via embedding similarity. This makes corrections natural: users
  //    can say `supersedes: "my earlier Neo4j decision"` instead of memorizing ids.
  const supersededIds = await resolveSupersedesInput(engine, spec, input.supersedes);
  for (const priorId of supersededIds) {
    await addSupersedes(conn, atomTable, id, priorId, now);
  }

  // 4. Enqueue extraction job. Both text and structured modes enqueue for now;
  //    structured-mode fast-path (resolver inline) comes in Phase 10.
  await enqueueJob(conn, id);

  return { id, superseded: supersededIds };
}

// ─── Kuzu write helpers ─────────────────────────────────────────────────────

interface AtomRowInput {
  id: string;
  content: string;
  kind: string;
  salience: Salience;
  created_at: string;
  last_accessed: string;
  source_instance: string;
  cwd: string;
  source_kind: string;
  foreign_episode: string;
}

async function createAtom(
  conn: Conn,
  atomTable: string,
  spec: SchemaSpec,
  row: AtomRowInput,
): Promise<void> {
  // Conditional columns: tier (if aging), embedding (if embeddings). The
  // write path never writes embedding values; those arrive from the worker.
  const extraProps: string[] = [];
  if (spec.agingEnabled) extraProps.push(`tier: 'hot'`);

  const query = `
    CREATE (a:${atomTable} {
      id: $id,
      content: $content,
      kind: $kind,
      salience: $salience,
      created_at: $created_at,
      last_accessed: $last_accessed,
      access_count: 0,
      source_instance: $source_instance,
      cwd: $cwd,
      source_kind: $source_kind,
      extracted: false,
      superseded_by: '',
      foreign_episode: $foreign_episode${extraProps.length ? ',\n      ' + extraProps.join(',\n      ') : ''}
    })
  `;
  const ps = await conn.prepare(query);
  await conn.execute(ps, row as unknown as Record<string, KuzuValue>);
}

async function linkInEpisode(
  conn: Conn,
  atomTable: string,
  atomId: string,
  episodeId: string,
): Promise<void> {
  const ps = await conn.prepare(`
    MATCH (a:${atomTable} {id: $aid}), (e:Episode {id: $eid})
    CREATE (a)-[:IN_EPISODE]->(e)
  `);
  await conn.execute(ps, { aid: atomId, eid: episodeId });
}

async function addSupersedes(
  conn: Conn,
  atomTable: string,
  newAtomId: string,
  priorAtomId: string,
  now: string,
): Promise<void> {
  // Create the SUPERSEDES edge and flag the prior atom's superseded_by field.
  const edgePs = await conn.prepare(`
    MATCH (n:${atomTable} {id: $nid}), (p:${atomTable} {id: $pid})
    CREATE (n)-[:SUPERSEDES {created_at: $created_at}]->(p)
  `);
  await conn.execute(edgePs, { nid: newAtomId, pid: priorAtomId, created_at: now });

  const flagPs = await conn.prepare(`
    MATCH (p:${atomTable} {id: $pid}) SET p.superseded_by = $nid
  `);
  await conn.execute(flagPs, { pid: priorAtomId, nid: newAtomId });
}

// ─── Normalization ──────────────────────────────────────────────────────────

/** ULIDs are 26 chars of 0-9A-Z (Crockford base32). */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function looksLikeAtomId(s: string): boolean {
  return ULID_RE.test(s);
}

/**
 * Resolve `supersedes` (id, id[], or free-text cue) to a list of prior atom
 * ids to link via SUPERSEDES edges.
 *
 * - If a string looks like a ULID, treat as id.
 * - Otherwise, vector-search atoms by embedding similarity to the cue, take
 *   the top 1 above threshold. Empty list if nothing matches confidently.
 */
async function resolveSupersedesInput(
  engine: GraphEngineInstance,
  spec: SchemaSpec,
  supersedes: string | string[] | undefined,
): Promise<string[]> {
  if (!supersedes) return [];
  const inputs = typeof supersedes === 'string' ? [supersedes] : supersedes;
  const ids: string[] = [];

  for (const item of inputs) {
    if (looksLikeAtomId(item)) {
      ids.push(item);
      continue;
    }
    // Fuzzy cue: vector search. Requires embeddings; no-op if disabled.
    if (!spec.embeddingsEnabled) continue;
    try {
      const queryVec = await embed(item);
      const hits = await vectorSearchAtoms(engine, queryVec, 3);
      // Only accept confident matches — corrections should be deliberate.
      const top = hits[0];
      if (top && top.similarity >= 0.55) {
        ids.push(top.item.id);
      }
    } catch { /* model unavailable — silently skip this cue */ }
  }
  return ids;
}
