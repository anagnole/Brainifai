// ─── Longform "is it useful" test ──────────────────────────────────────────
// Writes ~50 memories across ~30 days of a simulated life, with varied
// entities, overlapping people/projects, decisions that get corrected, and
// parallel personal/work streams. Then runs a query suite and reports what
// retrieval gets right (and wrong).
//
// Run:
//   npx tsx src/scripts/longform-test.ts              # stub extractor (fast, deterministic)
//   npx tsx src/scripts/longform-test.ts --real       # real LLM (slow, ~12+ min)
//   npx tsx src/scripts/longform-test.ts --persist    # keep DB at /tmp/brainifai-longform/

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEngine, ensureWorker, closeAllEngines } from '../graph-engine/singleton.js';
import { generalSpec } from '../instances/general/schema.js';
import {
  consolidate, working_memory, associate, recall_episode,
} from '../instances/general/functions.js';
import { processOneJob, type ExtractedEntity } from '../graph-engine/worker.js';
import { countByStatus } from '../graph-engine/queue.js';

// ─── Corpus ────────────────────────────────────────────────────────────────

/** `daysAgo` is relative to "now" when the script runs. */
interface MemoryEntry {
  daysAgo: number;
  content: string;
  kind: string;
  salience?: 'low' | 'normal' | 'high';
  cwd: string;
  /** Deterministic entities for the stub extractor. Real LLM ignores these. */
  entities: ExtractedEntity[];
}

const CWD_BRAINIFAI = '/Users/anagnole/Projects/Brainifai';
const CWD_FLAIO = '/Users/anagnole/Projects/flaio-cli';
const CWD_FIGMA = '/Users/anagnole/Projects/figma-writer-mcp';
const CWD_HOME = '/Users/anagnole';
const CWD_PERSONAL = '/Users/anagnole/personal';

const CORPUS: MemoryEntry[] = [
  // ─── Week 1 (28-22 days ago) — Brainifai kickoff + misc ──────────────────
  {
    daysAgo: 28, kind: 'decision', salience: 'high', cwd: CWD_BRAINIFAI,
    content: 'Decided to build Brainifai as a personal knowledge graph. Anna Smith pushed for Kuzu as the embedded DB.',
    entities: [
      { name: 'Brainifai', type: 'project', prominence: 0.9 },
      { name: 'Anna Smith', type: 'person', prominence: 0.5 },
      { name: 'Kuzu', type: 'tool', prominence: 0.7 },
    ],
  },
  {
    daysAgo: 27, kind: 'decision', cwd: CWD_BRAINIFAI, salience: 'high',
    content: 'Multi-instance architecture: one per project folder. Global at ~/.brainifai.',
    entities: [
      { name: 'Brainifai', type: 'project', prominence: 0.6 },
      { name: 'multi-instance architecture', type: 'concept', prominence: 0.9 },
    ],
  },
  {
    daysAgo: 26, kind: 'observation', cwd: CWD_HOME,
    content: 'Started reading Thinking Fast and Slow by Kahneman. Bought at Waterstones.',
    entities: [
      { name: 'Thinking Fast and Slow', type: 'concept', prominence: 0.9 },
      { name: 'Kahneman', type: 'person', prominence: 0.6 },
      { name: 'Waterstones', type: 'place', prominence: 0.3 },
    ],
  },
  {
    daysAgo: 25, kind: 'observation', cwd: CWD_PERSONAL,
    content: 'Coffee with Maria in Amsterdam. She showed new Figma design system patterns.',
    entities: [
      { name: 'Maria', type: 'person', prominence: 0.8 },
      { name: 'Amsterdam', type: 'place', prominence: 0.5 },
      { name: 'Figma', type: 'tool', prominence: 0.6 },
    ],
  },
  {
    daysAgo: 24, kind: 'decision', cwd: CWD_FLAIO,
    content: 'flaio-cli will use commander for CLI parsing. Same as Brainifai.',
    entities: [
      { name: 'flaio-cli', type: 'project', prominence: 0.8 },
      { name: 'commander', type: 'tool', prominence: 0.6 },
      { name: 'Brainifai', type: 'project', prominence: 0.3 },
    ],
  },
  {
    daysAgo: 23, kind: 'observation', cwd: CWD_HOME,
    content: 'Morning run: 5k in 23:10. Feeling slow this week.',
    entities: [
      { name: '5k run', type: 'concept', prominence: 0.7 },
    ],
  },

  // ─── Week 2 (21-15 days ago) — debugging + corrections ───────────────────
  {
    daysAgo: 21, kind: 'bug-fix', cwd: CWD_BRAINIFAI, salience: 'high',
    content: 'Kuzu segfaults when two processes try to write concurrently. Added single-writer file lock.',
    entities: [
      { name: 'Kuzu', type: 'tool', prominence: 0.8 },
      { name: 'single-writer lock', type: 'concept', prominence: 0.9 },
      { name: 'Brainifai', type: 'project', prominence: 0.3 },
    ],
  },
  {
    daysAgo: 20, kind: 'decision', cwd: CWD_BRAINIFAI, salience: 'high',
    content: 'Going with the event-bus orchestrator design. Claude CLI subprocess routes each message to matching instance.',
    entities: [
      { name: 'Brainifai', type: 'project', prominence: 0.3 },
      { name: 'orchestrator', type: 'concept', prominence: 0.9 },
      { name: 'event bus', type: 'concept', prominence: 0.7 },
      { name: 'Claude CLI', type: 'tool', prominence: 0.5 },
    ],
  },
  {
    daysAgo: 19, kind: 'observation', cwd: CWD_PERSONAL,
    content: 'Called my sister Anna for her birthday. She starts a new job in Paris next month.',
    entities: [
      { name: 'Anna', type: 'person', prominence: 0.9 },          // NOTE: different Anna
      { name: 'Paris', type: 'place', prominence: 0.4 },
    ],
  },
  {
    daysAgo: 18, kind: 'observation', cwd: CWD_BRAINIFAI,
    content: 'Lisa (stakeholder) asked for a demo by end of month. Healthcare pilot candidate.',
    entities: [
      { name: 'Lisa', type: 'person', prominence: 0.9 },
      { name: 'Brainifai', type: 'project', prominence: 0.5 },
      { name: 'healthcare pilot', type: 'concept', prominence: 0.7 },
    ],
  },
  {
    daysAgo: 17, kind: 'insight', cwd: CWD_HOME,
    content: 'Kahneman: System 1 is fast and intuitive; System 2 is deliberate. Brains cache System 2 results to make them feel like System 1.',
    entities: [
      { name: 'Kahneman', type: 'person', prominence: 0.5 },
      { name: 'System 1', type: 'concept', prominence: 0.9 },
      { name: 'System 2', type: 'concept', prominence: 0.9 },
    ],
  },
  {
    daysAgo: 16, kind: 'observation', cwd: CWD_HOME,
    content: '5k run: 22:50. Starting to feel the training.',
    entities: [
      { name: '5k run', type: 'concept', prominence: 0.8 },
    ],
  },

  // ─── Week 3 (14-8 days ago) — insights + corrections ─────────────────────
  {
    daysAgo: 14, kind: 'insight', cwd: CWD_BRAINIFAI, salience: 'high',
    content: 'Context priming is how brains disambiguate: two Annas in my life, but the work one lights up when I’m in the Brainifai folder.',
    entities: [
      { name: 'context priming', type: 'concept', prominence: 0.9 },
      { name: 'Brainifai', type: 'project', prominence: 0.4 },
    ],
  },
  {
    daysAgo: 13, kind: 'observation', cwd: CWD_BRAINIFAI,
    content: 'Lisa pushed again for a healthcare pilot. Wants FHIR ingestion as a differentiator.',
    entities: [
      { name: 'Lisa', type: 'person', prominence: 0.7 },
      { name: 'FHIR', type: 'concept', prominence: 0.8 },
      { name: 'healthcare pilot', type: 'concept', prominence: 0.7 },
    ],
  },
  {
    daysAgo: 12, kind: 'correction', cwd: CWD_BRAINIFAI, salience: 'high',
    content: 'Ditching the event-bus orchestrator. Cascade pattern is simpler: each consolidate dual-writes to parent.',
    entities: [
      { name: 'orchestrator', type: 'concept', prominence: 0.7 },
      { name: 'event bus', type: 'concept', prominence: 0.5 },
      { name: 'cascade pattern', type: 'concept', prominence: 0.9 },
      { name: 'Brainifai', type: 'project', prominence: 0.3 },
    ],
  },
  {
    daysAgo: 11, kind: 'observation', cwd: CWD_PERSONAL,
    content: 'Trip to Berlin with Maria for long weekend. Visited Mauerpark flea market.',
    entities: [
      { name: 'Berlin', type: 'place', prominence: 0.8 },
      { name: 'Maria', type: 'person', prominence: 0.7 },
      { name: 'Mauerpark', type: 'place', prominence: 0.5 },
    ],
  },
  {
    daysAgo: 10, kind: 'observation', cwd: CWD_PERSONAL,
    content: 'Finished Kahneman. Started The Pragmatic Programmer, 2nd edition.',
    entities: [
      { name: 'Kahneman', type: 'person', prominence: 0.3 },
      { name: 'Thinking Fast and Slow', type: 'concept', prominence: 0.4 },
      { name: 'The Pragmatic Programmer', type: 'concept', prominence: 0.9 },
    ],
  },
  {
    daysAgo: 9, kind: 'decision', cwd: CWD_FIGMA,
    content: 'figma-writer-mcp: landing the new diagram API. Using fal.ai for image generation.',
    entities: [
      { name: 'figma-writer-mcp', type: 'project', prominence: 0.9 },
      { name: 'Figma', type: 'tool', prominence: 0.5 },
      { name: 'fal.ai', type: 'tool', prominence: 0.6 },
    ],
  },
  {
    daysAgo: 8, kind: 'observation', cwd: CWD_HOME,
    content: '5k run: 22:15. Three weeks of consistent training is paying off.',
    entities: [
      { name: '5k run', type: 'concept', prominence: 0.8 },
    ],
  },

  // ─── Week 4 (7-1 days ago) — doc split + progress ────────────────────────
  {
    daysAgo: 7, kind: 'decision', cwd: CWD_BRAINIFAI, salience: 'high',
    content: 'Splitting graph-management doc into graph-engine (reusable) + general-instance-graph (per-type config). Engine is abstracted; types plug schema specs in.',
    entities: [
      { name: 'Brainifai', type: 'project', prominence: 0.4 },
      { name: 'graph engine', type: 'concept', prominence: 0.9 },
      { name: 'SchemaSpec', type: 'concept', prominence: 0.7 },
    ],
  },
  {
    daysAgo: 6, kind: 'observation', cwd: CWD_BRAINIFAI,
    content: 'Anna Smith reviewed the SchemaSpec. Minor tweaks on resolver weights.',
    entities: [
      { name: 'Anna Smith', type: 'person', prominence: 0.8 },
      { name: 'SchemaSpec', type: 'concept', prominence: 0.7 },
      { name: 'Brainifai', type: 'project', prominence: 0.3 },
    ],
  },
  {
    daysAgo: 5, kind: 'observation', cwd: CWD_PERSONAL,
    content: 'Dinner with Anna (sister) — she moved into her new Paris flat.',
    entities: [
      { name: 'Anna', type: 'person', prominence: 0.9 },         // again: sister Anna
      { name: 'Paris', type: 'place', prominence: 0.4 },
    ],
  },
  {
    daysAgo: 5, kind: 'preference', cwd: CWD_BRAINIFAI,
    content: 'For subprocess calls we use @anagnole/claude-cli-wrapper. Never raw spawn("claude", ...).',
    entities: [
      { name: '@anagnole/claude-cli-wrapper', type: 'tool', prominence: 0.9 },
      { name: 'Claude CLI', type: 'tool', prominence: 0.4 },
    ],
  },
  {
    daysAgo: 4, kind: 'bug-fix', cwd: CWD_BRAINIFAI,
    content: 'Resolver false-merged two Annas. Added exact-name + type fast path to short-circuit fuzzy scoring.',
    entities: [
      { name: 'resolver', type: 'concept', prominence: 0.9 },
      { name: 'Anna', type: 'person', prominence: 0.4 },
      { name: 'Brainifai', type: 'project', prominence: 0.3 },
    ],
  },
  {
    daysAgo: 3, kind: 'observation', cwd: CWD_HOME,
    content: '5k run: 21:45. New personal best. Aiming for sub-21 next month.',
    entities: [
      { name: '5k run', type: 'concept', prominence: 0.9 },
    ],
  },
  {
    daysAgo: 3, kind: 'insight', cwd: CWD_PERSONAL,
    content: 'Pragmatic Programmer: tracer bullets — build a thin end-to-end path first, not top-down or bottom-up.',
    entities: [
      { name: 'The Pragmatic Programmer', type: 'concept', prominence: 0.7 },
      { name: 'tracer bullets', type: 'concept', prominence: 0.9 },
    ],
  },
  {
    daysAgo: 2, kind: 'decision', cwd: CWD_BRAINIFAI, salience: 'high',
    content: 'MVP engine done: types, schema, lock, queue, LLM, write-path, resolver, worker, reconsolidation, reads. 104 tests green.',
    entities: [
      { name: 'graph engine', type: 'concept', prominence: 0.8 },
      { name: 'Brainifai', type: 'project', prominence: 0.5 },
      { name: 'MVP', type: 'concept', prominence: 0.7 },
    ],
  },

  // ─── This week (days -1 to 0) — very recent ──────────────────────────────
  {
    daysAgo: 1, kind: 'observation', cwd: CWD_BRAINIFAI,
    content: 'First smoke test with real Haiku extraction. ~14s per atom is slow; need batching.',
    entities: [
      { name: 'Haiku', type: 'tool', prominence: 0.7 },
      { name: 'Brainifai', type: 'project', prominence: 0.4 },
      { name: 'graph engine', type: 'concept', prominence: 0.5 },
    ],
  },
  {
    daysAgo: 1, kind: 'correction', cwd: CWD_BRAINIFAI,
    content: 'Actually, dropping embeddings from MVP. Keeping FTS + token fallback for cue lookup. Embeddings are Phase 8.',
    entities: [
      { name: 'embeddings', type: 'concept', prominence: 0.9 },
      { name: 'FTS', type: 'concept', prominence: 0.5 },
      { name: 'MVP', type: 'concept', prominence: 0.5 },
    ],
  },
  {
    daysAgo: 0, kind: 'observation', cwd: CWD_BRAINIFAI,
    content: 'Wrote general instance functions (working_memory, associate, recall_episode, consolidate) as thin wrappers over engine primitives.',
    entities: [
      { name: 'general instance', type: 'concept', prominence: 0.9 },
      { name: 'Brainifai', type: 'project', prominence: 0.3 },
      { name: 'working_memory', type: 'concept', prominence: 0.5 },
      { name: 'associate', type: 'concept', prominence: 0.5 },
    ],
  },
  {
    daysAgo: 0, kind: 'observation', cwd: CWD_PERSONAL,
    content: 'Lunch with Maria. She’s moving to Berlin full-time next month.',
    entities: [
      { name: 'Maria', type: 'person', prominence: 0.9 },
      { name: 'Berlin', type: 'place', prominence: 0.5 },
    ],
  },
];

// ─── Stub extractor (deterministic, looks up memory by content) ────────────

function makeStubExtractor(): (content: string) => Promise<ExtractedEntity[]> {
  const byContent = new Map<string, ExtractedEntity[]>();
  for (const m of CORPUS) byContent.set(m.content, m.entities);
  return async (content: string) => byContent.get(content) ?? [];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function log(s: string = ''): void { console.log(s); }
function truncate(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function exec(conn: any, cypher: string, params: any = {}): Promise<any[]> {
  if (Object.keys(params).length > 0) {
    const ps = await conn.prepare(cypher);
    const result = await conn.execute(ps, params);
    return (Array.isArray(result) ? result[0] : result).getAll();
  }
  const result = await conn.query(cypher);
  return (Array.isArray(result) ? result[0] : result).getAll();
}

// ─── Backdate a memory's atom + its episode start ──────────────────────────

async function backdate(conn: any, atomId: string, daysAgo: number): Promise<void> {
  const ts = new Date(Date.now() - daysAgo * 86400_000).toISOString();
  // Update atom timestamps
  const ps1 = await conn.prepare(`
    MATCH (a:Atom {id: $id})
    SET a.created_at = $ts, a.last_accessed = $ts
  `);
  await conn.execute(ps1, { id: atomId, ts });
  // Update containing Episode's start_time to the earliest atom's ts
  const ps2 = await conn.prepare(`
    MATCH (a:Atom {id: $id})-[:IN_EPISODE]->(ep:Episode)
    SET ep.start_time = $ts
  `);
  await conn.execute(ps2, { id: atomId, ts });
}

// ─── Query suite ───────────────────────────────────────────────────────────

interface QueryResult {
  name: string;
  pass: boolean;
  notes: string;
}

async function runQueries(engine: any): Promise<QueryResult[]> {
  const results: QueryResult[] = [];

  const record = (name: string, pass: boolean, notes: string) => {
    results.push({ name, pass, notes });
    log(`  ${pass ? '✓' : '✗'} ${name}`);
    if (notes) log(`      ${notes}`);
  };

  // Q1: working_memory — most recent items
  log('\n[Q1] working_memory({limit: 5}) — most recent across all scopes');
  const wm = await working_memory(engine, { limit: 5 });
  for (const a of wm) log(`    · ${a.kind.padEnd(12)} ${truncate(a.content, 70)}`);
  record('working_memory returns 5 most-recent atoms',
    wm.length === 5,
    `got ${wm.length} atoms`);

  // Q2: working_memory with scope='here' (should filter to CWD_BRAINIFAI atoms only)
  log('\n[Q2] working_memory({scope: "here", cwd: Brainifai}) — only Brainifai-scoped');
  const wmHere = await working_memory(engine, { scope: 'here', cwd: CWD_BRAINIFAI, limit: 5 });
  for (const a of wmHere) log(`    · ${a.kind.padEnd(12)} ${truncate(a.content, 70)}`);
  record('working_memory(scope:here) filters to cwd',
    wmHere.every((a) => a.cwd === CWD_BRAINIFAI),
    `${wmHere.length} atoms, all with cwd=${CWD_BRAINIFAI}? ${wmHere.every((a) => a.cwd === CWD_BRAINIFAI)}`);

  // Q3: associate("Kuzu") — should return the decision + bug-fix memories
  log('\n[Q3] associate({cue: "Kuzu"})');
  const kuzuHits = await associate(engine, { cue: 'Kuzu', limit: 10 });
  for (const h of kuzuHits) log(`    · score=${h.score.toFixed(2)} ${truncate(h.atom.content, 70)}`);
  record('associate("Kuzu") finds Kuzu-related memories',
    kuzuHits.length >= 1,
    `returned ${kuzuHits.length} hits`);

  // Q4: associate("orchestrator") — should return BOTH the original decision and the correction
  log('\n[Q4] associate({cue: "orchestrator"}) — should return both the original decision and the correction');
  const orchHits = await associate(engine, { cue: 'orchestrator', limit: 10 });
  for (const h of orchHits) log(`    · score=${h.score.toFixed(2)} ${truncate(h.atom.content, 80)}`);
  record('associate("orchestrator") returns multiple memories (original + correction)',
    orchHits.length >= 2,
    `returned ${orchHits.length} hits`);

  // Q5: associate("Anna") — ambiguity test. Should return both Anna Smith (work) and Anna (sister)
  log('\n[Q5] associate({cue: "Anna"}) — two Annas: coworker + sister');
  const annaHits = await associate(engine, { cue: 'Anna', limit: 10 });
  for (const h of annaHits) log(`    · score=${h.score.toFixed(2)} ${truncate(h.atom.content, 70)}`);
  const hasWorkAnna = annaHits.some((h) => /Smith|SchemaSpec|reviewed|resolver/.test(h.atom.content));
  const hasSisterAnna = annaHits.some((h) => /Paris|sister|birthday/.test(h.atom.content));
  record('associate("Anna") surfaces both coworker and sister',
    hasWorkAnna && hasSisterAnna,
    `work Anna: ${hasWorkAnna}, sister Anna: ${hasSisterAnna}`);

  // Q6: associate("Berlin") — should surface Maria-related memories
  log('\n[Q6] associate({cue: "Berlin"})');
  const berlinHits = await associate(engine, { cue: 'Berlin', limit: 5 });
  for (const h of berlinHits) log(`    · score=${h.score.toFixed(2)} ${truncate(h.atom.content, 70)}`);
  record('associate("Berlin") finds both Berlin memories (trip + Maria moving)',
    berlinHits.length >= 2,
    `returned ${berlinHits.length} hits`);

  // Q7: associate("Kahneman") — should find the reading memories + insights
  log('\n[Q7] associate({cue: "Kahneman"})');
  const kahneHits = await associate(engine, { cue: 'Kahneman', limit: 5 });
  for (const h of kahneHits) log(`    · score=${h.score.toFixed(2)} ${truncate(h.atom.content, 70)}`);
  record('associate("Kahneman") finds reading + insight memories',
    kahneHits.length >= 2,
    `returned ${kahneHits.length} hits`);

  // Q8: associate("5k") — recurring theme over 4 runs
  log('\n[Q8] associate({cue: "5k"}) — recurring running theme');
  const runHits = await associate(engine, { cue: '5k', limit: 10 });
  for (const h of runHits) log(`    · score=${h.score.toFixed(2)} ${truncate(h.atom.content, 70)}`);
  record('associate("5k") finds all 4 run logs',
    runHits.length === 4,
    `returned ${runHits.length} hits`);

  // Q9: recall_episode — all decisions
  log('\n[Q9] recall_episode({kind: "decision"}) — all decisions across the corpus');
  const decs = await recall_episode(engine, { kind: 'decision', limit: 50 });
  for (const a of decs) log(`    · ${truncate(a.content, 80)}`);
  record('recall_episode(kind:decision) returns all decision atoms',
    decs.length >= 5,
    `returned ${decs.length} decisions`);

  // Q10: recall_episode with time window — last week only
  log('\n[Q10] recall_episode({when: last 7 days}) — time-bounded');
  const lastWeek = await recall_episode(engine, {
    when: { from: new Date(Date.now() - 7 * 86400_000).toISOString() },
    limit: 50,
  });
  for (const a of lastWeek) log(`    · ${a.kind.padEnd(12)} ${truncate(a.content, 70)}`);
  record('recall_episode time-bounded to last 7 days',
    lastWeek.length >= 5 && lastWeek.length < CORPUS.length,
    `${lastWeek.length} atoms (expected subset of the corpus)`);

  // Q11: recall_episode where=Brainifai — location-bounded
  log('\n[Q11] recall_episode({where: Brainifai folder}) — location-bounded');
  const brainifaiEp = await recall_episode(engine, { where: CWD_BRAINIFAI, limit: 50 });
  for (const a of brainifaiEp) log(`    · ${a.kind.padEnd(12)} ${truncate(a.content, 70)}`);
  record('recall_episode where:Brainifai returns Brainifai-cwd atoms only',
    brainifaiEp.length > 0 && brainifaiEp.every((a) => a.cwd === CWD_BRAINIFAI),
    `${brainifaiEp.length} atoms, all Brainifai-cwd`);

  // Q12: recall_episode with cue — orchestrator decisions specifically
  log('\n[Q12] recall_episode({kind:"decision", cue:"orchestrator"}) — kind + cue');
  const orchDecs = await recall_episode(engine, { kind: 'decision', cue: 'orchestrator', limit: 10 });
  for (const a of orchDecs) log(`    · ${truncate(a.content, 80)}`);
  record('recall_episode cue reranks decisions',
    orchDecs.length >= 1 && /orchestrator|event.bus|cascade/.test(orchDecs[0]!.content.toLowerCase()),
    `top hit: ${orchDecs[0] ? truncate(orchDecs[0].content, 60) : '(none)'}`);

  // Q13: correction chain — "what's the current take on orchestrator?"
  // The correction ("cascade pattern") should be near the top. We accept
  // top-2 because cross-query reconsolidation (prior Qs bumped the original
  // orchestrator decision's last_accessed) is a real effect — brain-faithful,
  // but test-order-sensitive.
  log('\n[Q13] current take on orchestrator — top-2 of associate');
  const orch2 = await associate(engine, { cue: 'orchestrator', limit: 5 });
  for (const h of orch2.slice(0, 3)) log(`    · score=${h.score.toFixed(2)} ${truncate(h.atom.content, 70)}`);
  const top2HasCascade = orch2.slice(0, 2).some((h) => /cascade/i.test(h.atom.content));
  record('correction (cascade pattern) appears in top-2 of associate("orchestrator")',
    top2HasCascade,
    `top 2: ${orch2.slice(0, 2).map((h) => h.atom.kind).join(', ')}`);

  // Q14: hub entity — Brainifai has lots of CO_OCCURS
  log('\n[Q14] Inspecting Brainifai as a hub entity');
  const conn = engine.getConnection();
  const brainifai = await exec(conn, `
    MATCH (e:Entity {name: 'Brainifai'})-[:ASSOCIATED]-(other:Entity)
    RETURN other.name AS name
  `);
  log(`    Brainifai is ASSOCIATED with: ${brainifai.map((r: any) => r.name).join(', ')}`);
  record('Brainifai is a hub (has ≥4 ASSOCIATED edges)',
    brainifai.length >= 4,
    `${brainifai.length} associations`);

  // Q15: cross-context entity — Maria appears in personal cwd, should be there
  log('\n[Q15] associate("Maria") — personal scope entity');
  const mariaHits = await associate(engine, { cue: 'Maria', limit: 5 });
  for (const h of mariaHits) log(`    · score=${h.score.toFixed(2)} ${truncate(h.atom.content, 70)}`);
  // Top 3 should be personal-scope; tangential hits (figma via Figma
  // CO_OCCURS) can appear lower but shouldn't outrank direct Maria mentions.
  const top3Personal = mariaHits.slice(0, 3).every((h) => h.atom.cwd?.includes('personal'));
  record('associate("Maria") top-3 are all personal-scope direct mentions',
    top3Personal,
    `top 3 cwds: ${mariaHits.slice(0, 3).map((h) => h.atom.cwd ?? '(none)').join(', ')}`);

  return results;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const useReal = process.argv.includes('--real');
  const persist = process.argv.includes('--persist');

  const dbDir = persist ? '/tmp/brainifai-longform' : join(tmpdir(), `brainifai-longform-${Date.now()}`);
  if (persist) {
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'kuzu');

  log(`mode:       ${useReal ? 'real LLM (Claude Haiku)' : 'stub extractor (deterministic)'}`);
  log(`db:         ${dbPath}`);
  log(`persist:    ${persist}`);
  log(`corpus:     ${CORPUS.length} memories spanning ${Math.max(...CORPUS.map((m) => m.daysAgo))} days`);
  log('');

  try {
    log('[1] Opening engine...');
    const engine = await getEngine(dbPath, generalSpec);

    log('[2] Writing memories...');
    const atomIds: string[] = [];
    for (const m of CORPUS) {
      const r = await consolidate(engine, {
        content: m.content,
        kind: m.kind,
        salience: m.salience ?? 'normal',
        cwd: m.cwd,
      });
      atomIds.push(r.id);
    }
    log(`    wrote ${CORPUS.length} atoms`);

    log('[3] Draining extraction queue...');
    if (useReal) {
      ensureWorker(engine, { emptyPollMs: 500 });
      const startedAt = Date.now();
      for (let i = 0; i < 1800; i++) {
        await sleep(1000);
        const counts = await countByStatus(engine.getConnection());
        if (counts.queued === 0 && counts.in_progress === 0) {
          log(`    done after ${i + 1}s — ${counts.done} extracted, ${counts.failed} failed`);
          break;
        }
        if (i % 10 === 0) log(`    t=${i}s queued=${counts.queued} in_progress=${counts.in_progress} done=${counts.done}`);
        if (Date.now() - startedAt > 30 * 60_000) { log('    bailing after 30 min'); break; }
      }
    } else {
      const extract = makeStubExtractor();
      let ticks = 0;
      while (ticks < CORPUS.length + 5) {
        const result = await processOneJob(engine, { extract });
        if (result === 'empty') break;
        ticks++;
      }
      log(`    processed ${ticks} jobs`);
    }

    log('[4] Backdating atoms to match the corpus timeline...');
    const conn = engine.getConnection();
    for (let i = 0; i < CORPUS.length; i++) {
      await backdate(conn, atomIds[i]!, CORPUS[i]!.daysAgo);
    }
    log('    timestamps applied.');

    log('[5] Rebuilding FTS indexes...');
    await engine.rebuildFtsIndexes();

    // ── Snapshot ──
    const atomCount = Number((await exec(conn, `MATCH (a:Atom) RETURN count(a) AS c`))[0].c);
    const entityCount = Number((await exec(conn, `MATCH (e:Entity) RETURN count(e) AS c`))[0].c);
    const mentCount = Number((await exec(conn, `MATCH (:Atom)-[r:MENTIONS]->(:Entity) RETURN count(r) AS c`))[0].c);
    const assocCount = Number((await exec(conn, `MATCH (:Entity)-[r:ASSOCIATED]->(:Entity) RETURN count(r) AS c`))[0].c);
    const episodeCount = Number((await exec(conn, `MATCH (e:Episode) RETURN count(e) AS c`))[0].c);

    log('');
    log(`Graph: atoms=${atomCount} entities=${entityCount} episodes=${episodeCount} MENTIONS=${mentCount} ASSOCIATED=${assocCount}`);

    const topEntities = await exec(conn, `
      MATCH (e:Entity) RETURN e.name AS n, e.type AS t, e.mention_count AS mc
      ORDER BY mc DESC LIMIT 10
    `);
    log('Top 10 entities by mention_count:');
    for (const e of topEntities) log(`    ${String(e.n).padEnd(32)} ${String(e.t).padEnd(10)} mc=${e.mc}`);
    log('');

    log('[6] Query suite:');
    const results = await runQueries(engine);

    // Summary
    log('');
    log('─── SUMMARY ───────────────────────────────────────────────────────────');
    const passed = results.filter((r) => r.pass).length;
    const failed = results.filter((r) => !r.pass).length;
    for (const r of results) log(`  ${r.pass ? '✓' : '✗'} ${r.name}`);
    log('');
    log(`${passed}/${results.length} checks passed  (${failed} failed)`);
  } catch (err) {
    console.error('longform test crashed:', err);
    process.exitCode = 1;
  } finally {
    await closeAllEngines();
    if (!persist) {
      try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
    } else {
      log(`\n(DB persisted at ${dbPath})`);
    }
  }
}

main();
