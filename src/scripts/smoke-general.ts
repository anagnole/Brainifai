// ─── Smoke test: general instance end-to-end ────────────────────────────────
// Opens a temp Kuzu DB, initializes the general schema, writes a handful of
// memories, waits for the extraction worker to catch up, then exercises the
// 4 brain-like retrieval primitives. Prints human-readable output.
//
// Run with:
//   npx tsx src/scripts/smoke-general.ts
// or:
//   npx tsx src/scripts/smoke-general.ts --stub    (offline — no real LLM)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEngine, ensureWorker, closeAllEngines } from '../graph-engine/singleton.js';
import { generalSpec } from '../instances/general/schema.js';
import {
  consolidate, working_memory, associate, recall_episode,
} from '../instances/general/functions.js';
import { countByStatus } from '../graph-engine/queue.js';
import { processOneJob, type ExtractedEntity } from '../graph-engine/worker.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const MEMORIES = [
  {
    content: 'Decided to build Brainifai as a personal knowledge graph using Kuzu as the embedded graph DB.',
    kind: 'decision', salience: 'high' as const,
  },
  {
    content: 'The orchestrator is obsolete — each instance ingests its own sources, and a cascade pattern dual-writes cross-instance memories to global.',
    kind: 'decision', salience: 'high' as const,
  },
  {
    content: 'Anna Smith pushed the first commit on the graph-engine refactor today.',
    kind: 'observation', salience: 'normal' as const,
  },
  {
    content: 'Claude Haiku handles LLM entity extraction via the @anagnole/claude-cli-wrapper. Timeout 30s, model claude-haiku-4-5.',
    kind: 'observation', salience: 'normal' as const,
  },
];

// Deterministic stub — used when --stub is passed so the smoke test runs
// offline. Maps content keywords to entity lists.
function stubExtractor(content: string): ExtractedEntity[] {
  const lc = content.toLowerCase();
  const out: ExtractedEntity[] = [];
  if (lc.includes('brainifai')) out.push({ name: 'Brainifai', type: 'project', prominence: 0.9 });
  if (lc.includes('kuzu'))      out.push({ name: 'Kuzu',      type: 'concept', prominence: 0.8 });
  if (lc.includes('orchestrator')) out.push({ name: 'Orchestrator', type: 'concept', prominence: 0.85 });
  if (lc.includes('cascade'))   out.push({ name: 'Cascade',   type: 'concept', prominence: 0.6 });
  if (lc.includes('anna'))      out.push({ name: 'Anna Smith', type: 'person',  prominence: 0.7 });
  if (lc.includes('claude'))    out.push({ name: 'Claude',    type: 'concept', prominence: 0.7 });
  if (lc.includes('haiku'))     out.push({ name: 'Haiku',     type: 'concept', prominence: 0.6 });
  if (lc.includes('graph-engine') || lc.includes('graph engine')) {
    out.push({ name: 'Graph Engine', type: 'concept', prominence: 0.75 });
  }
  return out;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const useStub = process.argv.includes('--stub');

  const tmpDir = mkdtempSync(join(tmpdir(), 'brainifai-smoke-'));
  const dbPath = join(tmpDir, 'kuzu');

  log(`mode: ${useStub ? 'stub extractor (offline)' : 'real LLM (Claude Haiku)'}`);
  log(`db:   ${dbPath}`);
  log('');

  try {
    // ── 1. Boot the engine ────────────────────────────────────────────────
    log('[1] Opening engine + starting worker...');
    const engine = await getEngine(dbPath, generalSpec);

    // ── 2. Write memories ─────────────────────────────────────────────────
    log('[2] Writing memories...');
    const ids: string[] = [];
    for (const m of MEMORIES) {
      const r = await consolidate(engine, m);
      ids.push(r.id);
      log(`    + ${m.kind.padEnd(12)} ${r.id.slice(-6)} ${m.content.slice(0, 60)}${m.content.length > 60 ? '…' : ''}`);
    }
    log('');

    // ── 3. Drain the extraction queue ─────────────────────────────────────
    log('[3] Draining extraction queue...');
    if (useStub) {
      // Process each job synchronously with the stub
      let ticks = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = await processOneJob(engine, {
          extract: async (content) => stubExtractor(content),
        });
        if (result === 'empty') break;
        ticks++;
        if (ticks > 20) {
          log('    ! bailing out after 20 ticks');
          break;
        }
      }
      log(`    ${ticks} jobs processed`);
    } else {
      // Start a real worker (real LLM via @anagnole/claude-cli-wrapper) and
      // poll until the queue is empty + all atoms extracted.
      ensureWorker(engine, { emptyPollMs: 500 });
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const counts = await countByStatus(engine.getConnection());
        if (counts.queued === 0 && counts.in_progress === 0) {
          log(`    done after ${i + 1}s: ${counts.done} extracted, ${counts.failed} failed`);
          break;
        }
        if (i % 5 === 0) {
          log(`    ${i + 1}s: queued=${counts.queued} in_progress=${counts.in_progress} done=${counts.done} failed=${counts.failed}`);
        }
      }
    }
    log('');

    // FTS is immutable-after-creation; after the worker wrote new entities we
    // need to rebuild so associate() can find them by name cue.
    log('    rebuilding FTS indexes...');
    await engine.rebuildFtsIndexes();
    log('');

    // ── 4. working_memory() ───────────────────────────────────────────────
    log('[4] working_memory() — recent tail across all scopes');
    const wm = await working_memory(engine, { limit: 5 });
    for (const a of wm) {
      log(`    - ${a.kind.padEnd(12)} ${a.tier ?? '?'}\t${truncate(a.content, 70)}`);
    }
    log('');

    // ── 5. associate(cue) ────────────────────────────────────────────────
    log('[5] associate({cue: "orchestrator"})');
    const hits = await associate(engine, { cue: 'orchestrator', limit: 5 });
    if (hits.length === 0) {
      log('    (no hits — cue not in the entity index)');
    }
    for (const h of hits) {
      log(`    - score=${h.score.toFixed(3)} matched=${h.matched_entities}\t${truncate(h.atom.content, 70)}`);
    }
    log('');

    // ── 6. associate another cue ─────────────────────────────────────────
    log('[6] associate({cue: "Kuzu"})');
    const hits2 = await associate(engine, { cue: 'Kuzu', limit: 5 });
    if (hits2.length === 0) log('    (no hits)');
    for (const h of hits2) {
      log(`    - score=${h.score.toFixed(3)} matched=${h.matched_entities}\t${truncate(h.atom.content, 70)}`);
    }
    log('');

    // ── 7. recall_episode without cue (this session's atoms) ──────────────
    log('[7] recall_episode({}) — all atoms in matching episodes');
    const recalled = await recall_episode(engine, { limit: 10 });
    for (const a of recalled) {
      log(`    - ${a.kind.padEnd(12)} ${truncate(a.content, 70)}`);
    }
    log('');

    // ── 8. recall_episode with kind filter ────────────────────────────────
    log('[8] recall_episode({kind: "decision"})');
    const decisions = await recall_episode(engine, { kind: 'decision', limit: 10 });
    for (const a of decisions) {
      log(`    - ${truncate(a.content, 80)}`);
    }
    log('');

    // ── 9. Inspect the graph ──────────────────────────────────────────────
    log('[9] Graph snapshot');
    const conn = engine.getConnection();
    const atomCount = await singleRow(conn, `MATCH (a:Atom) RETURN count(a) AS c`, 'c');
    const entityCount = await singleRow(conn, `MATCH (e:Entity) RETURN count(e) AS c`, 'c');
    const mentCount = await singleRow(conn, `MATCH (:Atom)-[r:MENTIONS]->(:Entity) RETURN count(r) AS c`, 'c');
    const assocCount = await singleRow(conn, `MATCH (:Entity)-[r:ASSOCIATED]->(:Entity) RETURN count(r) AS c`, 'c');
    const episodeCount = await singleRow(conn, `MATCH (e:Episode) RETURN count(e) AS c`, 'c');
    log(`    atoms=${atomCount}  entities=${entityCount}  episodes=${episodeCount}  MENTIONS=${mentCount}  ASSOCIATED=${assocCount}`);

    if (entityCount > 0) {
      const names = await conn.query(`MATCH (e:Entity) RETURN e.name AS name, e.mention_count AS mc ORDER BY mc DESC`);
      const rows = await (Array.isArray(names) ? names[0] : names).getAll() as Array<{ name: string; mc: number | bigint }>;
      log(`    entities: ${rows.map((r) => `${r.name}(${Number(r.mc)})`).join(', ')}`);
    }
    log('');

    log('✅ smoke passed');
  } catch (err) {
    console.error('❌ smoke failed:', err);
    process.exitCode = 1;
  } finally {
    await closeAllEngines();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function log(s: string): void { console.log(s); }

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function singleRow(conn: any, cypher: string, field: string): Promise<number> {
  const result = await conn.query(cypher);
  const rows = await (Array.isArray(result) ? result[0] : result).getAll();
  return Number((rows[0] as any)[field] ?? 0);
}

main();
