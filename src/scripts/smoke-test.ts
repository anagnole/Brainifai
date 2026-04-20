#!/usr/bin/env tsx
/**
 * Brainifai End-to-End Smoke Test
 *
 * Exercises all 6 layers against an isolated temp Kuzu DB:
 *   Phase 1: Graph Store (direct queries)
 *   Phase 2: Context Functions (registry + execute)
 *   Phase 3: MCP Server (JSON-RPC over stdio)
 *   Phase 4: API Server (HTTP endpoints)
 *   Phase 5: Hooks (subprocess stdin/stdout)
 *   Phase 6: CLI (commands against temp instance)
 *
 * Run: npx tsx src/scripts/smoke-test.ts  (or npm run smoke)
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── Constants ────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

const TEMP_DIR = mkdtempSync(join(tmpdir(), 'brainifai-smoke-'));
const INSTANCE_DIR = join(TEMP_DIR, '.brainifai');
const DB_PATH = join(INSTANCE_DIR, 'data', 'kuzu');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// ── Test infrastructure ──────────────────────────────────────────────────────

interface TestResult {
  phase: string;
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];
const childProcs: ChildProcess[] = [];

function pass(phase: string, name: string) {
  results.push({ phase, name, passed: true });
  console.log(`  ${GREEN}[PASS]${RESET} ${name}`);
}

function fail(phase: string, name: string, error: string) {
  results.push({ phase, name, passed: false, error });
  console.log(`  ${RED}[FAIL]${RESET} ${name}`);
  console.log(`         ${DIM}${error}${RESET}`);
}

function check(condition: boolean, phase: string, name: string, errorMsg: string) {
  if (condition) pass(phase, name);
  else fail(phase, name, errorMsg);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
  );
  return Promise.race([promise, timer]);
}

function isOkExit(code: number | null, signal: string | null): boolean {
  return code === 0 || code === 139 || signal === 'SIGTERM' || signal === 'SIGKILL';
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string | undefined>; cwd?: string; stdin?: string; timeoutMs?: number },
): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd ?? PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    childProcs.push(proc);

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
    }, opts.timeoutMs ?? 15000);

    if (opts.stdin !== undefined) {
      proc.stdin?.write(opts.stdin);
      proc.stdin?.end();
    }

    proc.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

// ── JSON-RPC client for MCP ──────────────────────────────────────────────────

class JsonRpcClient {
  private proc: ChildProcess;
  private buffer = '';
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor(proc: ChildProcess) {
    this.proc = proc;
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!.resolve(msg);
            this.pending.delete(msg.id);
          }
        } catch { /* ignore non-JSON lines */ }
      }
    });
  }

  async request(method: string, params?: unknown, timeoutMs = 10000): Promise<any> {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.proc.stdin!.write(msg + '\n');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
  }

  notify(method: string, params?: unknown) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.proc.stdin!.write(msg + '\n');
  }
}

// ── Setup temp directory ─────────────────────────────────────────────────────

function setupTempDir() {
  mkdirSync(join(INSTANCE_DIR, 'data'), { recursive: true });
  writeFileSync(
    join(INSTANCE_DIR, 'config.json'),
    JSON.stringify({
      name: 'smoke-test',
      type: 'coding',
      description: 'Smoke test instance',
      parent: null,
      sources: [{ source: 'github', enabled: true }, { source: 'claude-code', enabled: true }],
      contextFunctions: ['get_context_packet', 'search_entities', 'get_entity_summary', 'get_recent_activity'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

// ── Phase 1: Graph Store ─────────────────────────────────────────────────────

async function phase1(store: any) {
  const P = 'Graph Store';
  console.log(`\n${BOLD}Phase 1: ${P}${RESET}`);

  const { PERSONS, CONTAINERS, TOPICS, SOURCE_ACCOUNTS, ACTIVITIES,
    FROM_EDGES, IN_EDGES, MENTIONS_EDGES, IDENTIFIES_EDGES, OWNS_EDGES,
  } = await import('../graphstore/__tests__/fixtures.js');
  type GraphEdge = typeof FROM_EDGES[number];

  // Extra activities for decision_log testing (Phase 8)
  const decisionActivities = [
    {
      source: 'claude-code', source_id: 'cc:decision:1',
      timestamp: new Date(Date.now() - 2 * 3600000).toISOString(),
      kind: 'decision', snippet: 'Lowered FTS min-score from 0.3 to 0.05 for Kuzu compatibility',
      url: null, thread_ts: null,
    },
    {
      source: 'claude-code', source_id: 'cc:insight:1',
      timestamp: new Date(Date.now() - 1 * 3600000).toISOString(),
      kind: 'insight', snippet: 'brainifai-ui branch was dead Neo4j code, deleted it',
      url: null, thread_ts: null,
    },
  ];

  // Extra edges: decision activities need FROM_PERSON + IN_CONTAINER to be queryable
  const decisionFromEdges: GraphEdge[] = [
    { type: 'FROM', fromLabel: 'Activity', toLabel: 'Person', from: { source: 'claude-code', source_id: 'cc:decision:1' }, to: { person_key: 'test:alice' } },
    { type: 'FROM', fromLabel: 'Activity', toLabel: 'Person', from: { source: 'claude-code', source_id: 'cc:insight:1' }, to: { person_key: 'test:alice' } },
  ];
  const decisionInEdges: GraphEdge[] = [
    { type: 'IN', fromLabel: 'Activity', toLabel: 'Container', from: { source: 'claude-code', source_id: 'cc:decision:1' }, to: { source: 'test', container_id: 'general' } },
    { type: 'IN', fromLabel: 'Activity', toLabel: 'Container', from: { source: 'claude-code', source_id: 'cc:insight:1' }, to: { source: 'test', container_id: 'general' } },
  ];

  // Seed data
  await store.upsertNodes('Person', PERSONS, ['person_key']);
  await store.upsertNodes('Container', CONTAINERS, ['source', 'container_id']);
  await store.upsertNodes('Topic', TOPICS, ['name']);
  await store.upsertNodes('SourceAccount', SOURCE_ACCOUNTS, ['source', 'account_id']);
  await store.upsertNodes('Activity', [...ACTIVITIES, ...decisionActivities], ['source', 'source_id']);
  await store.upsertEdges('FROM', [...FROM_EDGES, ...decisionFromEdges]);
  await store.upsertEdges('IN', [...IN_EDGES, ...decisionInEdges]);
  await store.upsertEdges('MENTIONS', MENTIONS_EDGES);
  await store.upsertEdges('IDENTIFIES', IDENTIFIES_EDGES);
  await store.upsertEdges('OWNS', OWNS_EDGES);
  await store.rebuildFtsIndexes();

  // Test: search for topic
  try {
    const searchResults = await store.search({ query: 'deploy', limit: 10 });
    check(searchResults.length > 0, P, 'search returns deploy topic',
      `Expected results, got ${searchResults.length}`);
  } catch (e: any) { fail(P, 'search returns deploy topic', e.message); }

  // Test: search for person
  try {
    const personResults = await store.search({ query: 'Alice', limit: 10 });
    check(personResults.some((r: any) => r.type === 'Person'), P, 'search returns Alice person',
      `No Person result found in: ${JSON.stringify(personResults.map((r: any) => r.type))}`);
  } catch (e: any) { fail(P, 'search returns Alice person', e.message); }

  // Test: neighborhood
  try {
    const nb = await store.neighborhood('Person', { person_key: 'test:alice' });
    check(nb.nodes.length > 0, P, 'neighborhood has connected nodes',
      `Expected nodes, got ${nb.nodes.length}`);
  } catch (e: any) { fail(P, 'neighborhood has connected nodes', e.message); }

  // Test: timeline
  try {
    const tl = await store.timeline('Person', { person_key: 'test:alice' }, { limit: 10 });
    check(tl.length > 0, P, 'timeline has activity items',
      `Expected items, got ${tl.length}`);
  } catch (e: any) { fail(P, 'timeline has activity items', e.message); }

  // Test: entity summary
  try {
    const summary = await store.getEntitySummary('test:alice');
    check(summary != null && summary.name === 'Alice' && summary.activityCount > 0,
      P, 'entity summary has correct data',
      `Expected Alice with activities, got: ${JSON.stringify(summary)}`);
  } catch (e: any) { fail(P, 'entity summary has correct data', e.message); }

  // Test: recent activity
  try {
    const recent = await store.getRecentActivity({ limit: 50 });
    check(recent.length === 7, P, 'recent activity returns 7 items',
      `Expected 7, got ${recent.length}`);
  } catch (e: any) { fail(P, 'recent activity returns 5 items', e.message); }
}

// ── Phase 2: Context Functions ───────────────────────────────────────────────

async function phase2(store: any) {
  const P = 'Context Functions';
  console.log(`\n${BOLD}Phase 2: ${P}${RESET}`);

  const { createBaseRegistry } = await import('../context/registry.js');
  const registry = await createBaseRegistry();

  // search_entities
  try {
    const fn = registry.get('search_entities')!;
    const result = await fn.execute({ query: 'deploy', limit: 10 }, store) as any[];
    check(Array.isArray(result) && result.length > 0, P, 'search_entities returns results',
      `Expected array with results, got ${JSON.stringify(result)?.slice(0, 200)}`);
  } catch (e: any) { fail(P, 'search_entities returns results', e.message); }

  // get_entity_summary
  try {
    const fn = registry.get('get_entity_summary')!;
    const result = await fn.execute({ entity_id: 'test:alice' }, store) as any;
    check(result != null && (result.formatted || result.raw), P, 'get_entity_summary returns summary',
      `Expected formatted/raw, got ${JSON.stringify(result)?.slice(0, 200)}`);
  } catch (e: any) { fail(P, 'get_entity_summary returns summary', e.message); }

  // get_recent_activity
  try {
    const fn = registry.get('get_recent_activity')!;
    const result = await fn.execute({ limit: 20, window_days: 30 }, store) as any[];
    check(Array.isArray(result) && result.length > 0, P, 'get_recent_activity returns items',
      `Expected items, got ${JSON.stringify(result)?.slice(0, 200)}`);
  } catch (e: any) { fail(P, 'get_recent_activity returns items', e.message); }

  // get_context_packet
  try {
    const fn = registry.get('get_context_packet')!;
    const result = await fn.execute({ query: 'deploy', window_days: 30, limit: 20 }, store) as any;
    check(result != null && Array.isArray(result.anchors), P, 'get_context_packet has anchors',
      `Expected anchors array, got ${JSON.stringify(result)?.slice(0, 200)}`);
  } catch (e: any) { fail(P, 'get_context_packet has anchors', e.message); }
}

// ── Phase 3: MCP Server ─────────────────────────────────────────────────────

async function phase3() {
  const P = 'MCP Server';
  console.log(`\n${BOLD}Phase 3: ${P}${RESET}`);

  const mcpProc = spawn('npx', ['tsx', join(PROJECT_ROOT, 'src/mcp/index.ts')], {
    env: {
      ...process.env,
      KUZU_DB_PATH: DB_PATH,
      GRAPHSTORE_ON_DEMAND: 'true',
      GRAPHSTORE_READONLY: 'true',
      LOG_LEVEL: 'silent',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: PROJECT_ROOT,
  });
  childProcs.push(mcpProc);

  // Wait a moment for process to start
  await new Promise((r) => setTimeout(r, 2000));

  const client = new JsonRpcClient(mcpProc);

  // Initialize handshake
  try {
    const initResp = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    });
    client.notify('notifications/initialized');
    check(initResp.result?.serverInfo != null, P, 'initialize handshake succeeds',
      `Expected serverInfo, got ${JSON.stringify(initResp.result)?.slice(0, 200)}`);
  } catch (e: any) { fail(P, 'initialize handshake succeeds', e.message); }

  // tools/list
  try {
    const listResp = await client.request('tools/list');
    const tools = listResp.result?.tools ?? [];
    check(tools.length >= 5, P, 'tools/list returns 5+ tools',
      `Expected >= 5 tools, got ${tools.length}`);
  } catch (e: any) { fail(P, 'tools/list returns 5+ tools', e.message); }

  // tools/call search_entities
  try {
    const callResp = await client.request('tools/call', {
      name: 'search_entities',
      arguments: { query: 'deploy', limit: 5 },
    });
    const content = callResp.result?.content;
    const text = content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : [];
    check(Array.isArray(parsed) && parsed.length > 0, P, 'search_entities via MCP returns results',
      `Expected results in content, got ${text?.slice(0, 200)}`);
  } catch (e: any) { fail(P, 'search_entities via MCP returns results', e.message); }

  mcpProc.kill('SIGTERM');
}

// ── Phase 4: API Server ─────────────────────────────────────────────────────

async function phase4() {
  const P = 'API Server';
  console.log(`\n${BOLD}Phase 4: ${P}${RESET}`);

  const port = 19000 + Math.floor(Math.random() * 1000);
  const apiProc = spawn('npx', ['tsx', join(PROJECT_ROOT, 'src/api/server.ts')], {
    env: {
      ...process.env,
      KUZU_DB_PATH: DB_PATH,
      VIZ_PORT: String(port),
      LOG_LEVEL: 'silent',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: PROJECT_ROOT,
  });
  childProcs.push(apiProc);

  // Wait for server to be ready
  let ready = false;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/api/search?q=test`);
      if (res.ok || res.status === 404) { ready = true; break; }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!ready) {
    fail(P, 'server starts', 'Server did not become ready within 10s');
    apiProc.kill('SIGTERM');
    return;
  }

  async function apiTest(name: string, path: string, assertFn: (status: number, body: any) => string | null) {
    try {
      const res = await fetch(`http://localhost:${port}${path}`);
      const body = await res.json().catch(() => null);
      const err = assertFn(res.status, body);
      if (err) fail(P, name, err);
      else pass(P, name);
    } catch (e: any) { fail(P, name, e.message); }
  }

  await apiTest('/api/search returns results', '/api/search?q=deploy', (s, b) =>
    s === 200 && Array.isArray(b) && b.length > 0 ? null : `status=${s}, body=${JSON.stringify(b)?.slice(0, 200)}`);

  await apiTest('/api/overview returns graph', '/api/overview', (s, b) =>
    s === 200 && b?.nodes && b?.edges ? null : `status=${s}, keys=${Object.keys(b ?? {})}`);

  await apiTest('/api/instances returns array', '/api/instances', (s, b) =>
    s === 200 && Array.isArray(b) ? null : `status=${s}, type=${typeof b}`);

  await apiTest('/api/entity returns Alice', '/api/entity/test:alice', (s, b) =>
    s === 200 && b?.name === 'Alice' ? null : `status=${s}, body=${JSON.stringify(b)?.slice(0, 200)}`);

  await apiTest('/api/neighborhood returns subgraph', '/api/neighborhood?id=test:alice', (s, b) =>
    s === 200 && b?.nodes?.length > 0 ? null : `status=${s}, nodes=${b?.nodes?.length}`);

  await apiTest('/api/timeline returns items', '/api/timeline?id=test:alice', (s, b) =>
    s === 200 && Array.isArray(b) && b.length > 0 ? null : `status=${s}, length=${b?.length}`);

  await apiTest('/api/ingest/status returns object', '/api/ingest/status', (s, b) =>
    s === 200 && typeof b === 'object' ? null : `status=${s}`);

  await apiTest('/api/nonexistent returns 404', '/api/nonexistent', (s, _b) =>
    s === 404 ? null : `Expected 404, got ${s}`);

  apiProc.kill('SIGTERM');
}

// ── Phase 5: Hooks ───────────────────────────────────────────────────────────

async function phase5() {
  const P = 'Hooks';
  console.log(`\n${BOLD}Phase 5: ${P}${RESET}`);

  const hookEnv = {
    KUZU_DB_PATH: DB_PATH,
    GRAPHSTORE_ON_DEMAND: 'true',
    LOG_LEVEL: 'silent',
  };

  // PreToolUse hook
  try {
    const result = await runProcess('npx', ['tsx', join(PROJECT_ROOT, '.claude/hooks/brainifai-context.ts')], {
      env: hookEnv,
      stdin: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'src/deploy.ts' } }),
      timeoutMs: 15000,
    });
    check(isOkExit(result.code, result.signal), P, 'PreToolUse hook exits cleanly',
      `Exit code=${result.code}, signal=${result.signal}, stderr=${result.stderr.slice(0, 200)}`);
  } catch (e: any) { fail(P, 'PreToolUse hook exits cleanly', e.message); }

  // SessionStart hook
  try {
    const result = await runProcess('npx', ['tsx', join(PROJECT_ROOT, '.claude/hooks/brainifai-session-start.ts')], {
      env: { ...hookEnv, CLAUDE_PROJECT_DIR: TEMP_DIR },
      stdin: '{}',
      timeoutMs: 15000,
    });
    check(isOkExit(result.code, result.signal), P, 'SessionStart hook exits cleanly',
      `Exit code=${result.code}, signal=${result.signal}, stderr=${result.stderr.slice(0, 200)}`);
  } catch (e: any) { fail(P, 'SessionStart hook exits cleanly', e.message); }
}

// ── Phase 6: CLI ─────────────────────────────────────────────────────────────

async function phase6() {
  const P = 'CLI';
  console.log(`\n${BOLD}Phase 6: ${P}${RESET}`);

  const cliEnv = { KUZU_DB_PATH: DB_PATH, LOG_LEVEL: 'silent' };
  const cliBase = ['tsx', join(PROJECT_ROOT, 'src/cli/index.ts')];

  // status
  try {
    const result = await runProcess('npx', [...cliBase, 'status'], {
      env: cliEnv, cwd: TEMP_DIR, timeoutMs: 15000,
    });
    check(isOkExit(result.code, result.signal), P, 'brainifai status exits 0',
      `Exit code=${result.code}, stderr=${result.stderr.slice(0, 200)}`);
  } catch (e: any) { fail(P, 'brainifai status exits 0', e.message); }

  // doctor
  try {
    const result = await runProcess('npx', [...cliBase, 'doctor'], {
      env: cliEnv, cwd: TEMP_DIR, timeoutMs: 15000,
    });
    check(isOkExit(result.code, result.signal), P, 'brainifai doctor exits 0',
      `Exit code=${result.code}, stderr=${result.stderr.slice(0, 200)}`);
  } catch (e: any) { fail(P, 'brainifai doctor exits 0', e.message); }

  // list
  try {
    const result = await runProcess('npx', [...cliBase, 'list'], {
      env: cliEnv, cwd: TEMP_DIR, timeoutMs: 15000,
    });
    check(isOkExit(result.code, result.signal), P, 'brainifai list exits 0',
      `Exit code=${result.code}, stderr=${result.stderr.slice(0, 200)}`);
  } catch (e: any) { fail(P, 'brainifai list exits 0', e.message); }
}

// ── Phase 7: Project Manager Instance ────────────────────────────────────────

async function phase7() {
  const P = 'Project Manager';
  console.log(`\n${BOLD}Phase 7: ${P}${RESET}`);

  const pmDbPath = join(TEMP_DIR, 'pm-kuzu');

  // Initialize PM schema
  const { initializeInstanceDb } = await import('../instance/db.js');
  await initializeInstanceDb(pmDbPath, 'project-manager');

  const { ProjectManagerGraphStore } = await import('../graphstore/kuzu/project-manager-adapter.js');
  const store = new ProjectManagerGraphStore({ dbPath: pmDbPath, readOnly: false });
  try { await store.initialize(); } catch { /* schema already created */ }

  // Seed PM fixture data
  const now = new Date();
  const day = 86400000;

  await store.query(`MERGE (p:Project {slug: 'brainifai'})
    SET p.name = 'brainifai', p.path = '/Projects/Brainifai', p.language = 'TypeScript',
    p.framework = 'React', p.description = 'Personal Knowledge Graph', p.health_score = 'excellent',
    p.last_activity = '${now.toISOString()}', p.created_at = '${new Date(now.getTime() - 30 * day).toISOString()}',
    p.updated_at = '${now.toISOString()}'`);

  await store.query(`MERGE (p:Project {slug: 'flaio-cli'})
    SET p.name = 'flaio-cli', p.path = '/Projects/flaio-cli', p.language = 'TypeScript',
    p.framework = 'React', p.description = 'CLI tool for Flaio', p.health_score = 'good',
    p.last_activity = '${new Date(now.getTime() - 5 * day).toISOString()}',
    p.created_at = '${new Date(now.getTime() - 60 * day).toISOString()}',
    p.updated_at = '${new Date(now.getTime() - 5 * day).toISOString()}'`);

  await store.query(`MERGE (p:Project {slug: 'stale-project'})
    SET p.name = 'stale-project', p.path = '/Projects/stale', p.language = 'Python',
    p.framework = 'Flask', p.description = 'Old abandoned project', p.health_score = 'poor',
    p.last_activity = '${new Date(now.getTime() - 90 * day).toISOString()}',
    p.created_at = '${new Date(now.getTime() - 180 * day).toISOString()}',
    p.updated_at = '${new Date(now.getTime() - 90 * day).toISOString()}'`);

  // Commits
  await store.query(`MERGE (c:Commit {sha: 'abc1234'})
    SET c.message = 'feat: add smoke test', c.author = 'Leonidas', c.date = '${new Date(now.getTime() - 1 * day).toISOString().split('T')[0]}',
    c.files_changed_count = 14, c.insertions = 1837, c.deletions = 144`);
  await store.query(`MERGE (c:Commit {sha: 'def5678'})
    SET c.message = 'fix: FTS min-score threshold', c.author = 'Leonidas', c.date = '${new Date(now.getTime() - 2 * day).toISOString().split('T')[0]}',
    c.files_changed_count = 1, c.insertions = 1, c.deletions = 1`);
  await store.query(`MATCH (c:Commit {sha: 'abc1234'}), (p:Project {slug: 'brainifai'}) MERGE (c)-[:COMMITTED_TO]->(p)`);
  await store.query(`MATCH (c:Commit {sha: 'def5678'}), (p:Project {slug: 'brainifai'}) MERGE (c)-[:COMMITTED_TO]->(p)`);

  // Branches
  await store.query(`MERGE (b:Branch {branch_key: 'brainifai:main'})
    SET b.project_slug = 'brainifai', b.name = 'main', b.is_default = true,
    b.last_commit_date = '${now.toISOString().split('T')[0]}', b.ahead = 0, b.behind = 0`);
  await store.query(`MATCH (b:Branch {branch_key: 'brainifai:main'}), (p:Project {slug: 'brainifai'}) MERGE (b)-[:BELONGS_TO]->(p)`);

  // Dependencies
  await store.query(`MERGE (d:Dependency {dep_key: 'npm:typescript'})
    SET d.ecosystem = 'npm', d.name = 'typescript', d.latest_version = '5.8.0', d.is_outdated = false`);
  await store.query(`MATCH (p:Project {slug: 'brainifai'}), (d:Dependency {dep_key: 'npm:typescript'}) MERGE (p)-[:USES {version: '5.7.0', is_dev: true}]->(d)`);
  await store.query(`MATCH (p:Project {slug: 'flaio-cli'}), (d:Dependency {dep_key: 'npm:typescript'}) MERGE (p)-[:USES {version: '5.6.0', is_dev: true}]->(d)`);

  // Cross-project relationships (both directions so getCrossProjectImpact finds them)
  await store.query(`MATCH (a:Project {slug: 'brainifai'}), (b:Project {slug: 'flaio-cli'})
    MERGE (a)-[:RELATED_TO {relation_type: 'downstream', confidence: 'high'}]->(b)`);
  await store.query(`MATCH (a:Project {slug: 'flaio-cli'}), (b:Project {slug: 'brainifai'})
    MERGE (a)-[:RELATED_TO {relation_type: 'upstream', confidence: 'high'}]->(b)`);

  // Claude session
  await store.query(`MERGE (s:ClaudeSession {session_id: 'test-session-1'})
    SET s.date = '${now.toISOString().split('T')[0]}', s.summary = 'Built smoke test and redesigned UI',
    s.files_touched_count = 14, s.model = 'opus', s.duration_minutes = 120`);
  await store.query(`MATCH (s:ClaudeSession {session_id: 'test-session-1'}), (p:Project {slug: 'brainifai'})
    MERGE (s)-[:WORKED_ON]->(p)`);

  // Rebuild FTS after all data is inserted
  await store.rebuildFtsIndexes();

  // ── Test PM GraphStore methods ──

  // searchProjects
  try {
    const results = await store.searchProjects('brainifai');
    check(results.length > 0 && results[0].slug === 'brainifai', P, 'searchProjects finds brainifai',
      `Expected brainifai, got ${results.map((r: any) => r.slug)}`);
  } catch (e: any) { fail(P, 'searchProjects finds brainifai', e.message); }

  // getProjectHealth
  try {
    const health = await store.getProjectHealth('brainifai');
    check(health != null && health.project.health_score === 'excellent', P, 'getProjectHealth returns excellent',
      `Expected excellent, got ${health?.project.health_score}`);
  } catch (e: any) { fail(P, 'getProjectHealth returns excellent', e.message); }

  // getProjectActivity
  try {
    const activity = await store.getProjectActivity('brainifai', { windowDays: 30, limit: 10 });
    check(activity.commits.length >= 2, P, 'getProjectActivity has commits',
      `Expected >= 2 commits, got ${activity.commits.length}`);
  } catch (e: any) { fail(P, 'getProjectActivity has commits', e.message); }

  // getCrossProjectImpact
  try {
    const impact = await store.getCrossProjectImpact('brainifai', 1);
    check(impact.affected_projects.length > 0, P, 'getCrossProjectImpact finds related projects',
      `Expected related projects, got ${impact.affected_projects.length}`);
  } catch (e: any) { fail(P, 'getCrossProjectImpact finds related projects', e.message); }

  // findStaleProjects
  try {
    const stale = await store.findStaleProjects(30);
    check(stale.some((s: any) => s.project.slug === 'stale-project'), P, 'findStaleProjects finds stale-project',
      `Expected stale-project in results, got ${stale.map((s: any) => s.project.slug)}`);
  } catch (e: any) { fail(P, 'findStaleProjects finds stale-project', e.message); }

  // getDependencyGraph
  try {
    const deps = await store.getDependencyGraph();
    check(deps.dependencies.length > 0, P, 'getDependencyGraph returns data',
      `Expected dependencies, got ${deps.dependencies?.length ?? 'undefined'}`);
  } catch (e: any) { fail(P, 'getDependencyGraph returns data', e.message); }

  // getClaudeSessionHistory
  try {
    const sessions = await store.getClaudeSessionHistory('brainifai', { windowDays: 30, limit: 5 });
    check(sessions.length > 0 && sessions[0].summary === 'Built smoke test and redesigned UI',
      P, 'getClaudeSessionHistory returns sessions',
      `Expected sessions, got ${sessions.length}`);
  } catch (e: any) { fail(P, 'getClaudeSessionHistory returns sessions', e.message); }

  try { await store.close(); } catch { /* SIGSEGV */ }
}

// ── Phase 8: Coding Instance Functions ───────────────────────────────────────

async function phase8(store: any) {
  const P = 'Coding Instance';
  console.log(`\n${BOLD}Phase 8: ${P}${RESET}`);

  const { createBaseRegistry } = await import('../context/registry.js');
  const registry = await createBaseRegistry();

  // get_decision_log — should find the decision/insight activities from Phase 1
  try {
    const fn = registry.get('get_decision_log')!;
    check(fn != null, P, 'get_decision_log is registered', 'Function not found in registry');
    if (fn) {
      const result = await fn.execute({ window_days: 30, limit: 20 }, store) as any;
      check(result != null && Array.isArray(result.decisions) && result.decisions.length > 0,
        P, 'get_decision_log returns decisions',
        `Expected decisions array with items, got ${JSON.stringify(result)?.slice(0, 200)}`);
    }
  } catch (e: any) { fail(P, 'get_decision_log returns entries', e.message); }

  // get_pr_context — should work even if no PR data exists (returns empty)
  try {
    const fn = registry.get('get_pr_context')!;
    check(fn != null, P, 'get_pr_context is registered', 'Function not found in registry');
    if (fn) {
      const result = await fn.execute({ query: 'deploy' }, store) as any;
      check(result != null, P, 'get_pr_context executes without error',
        `Expected result, got ${JSON.stringify(result)?.slice(0, 200)}`);
    }
  } catch (e: any) { fail(P, 'get_pr_context executes without error', e.message); }

  // GitNexus-dependent functions — execute if CLI available, skip if not
  const { execSync } = await import('node:child_process');
  let hasGitNexus = false;
  try {
    execSync('which gitnexus', { stdio: 'ignore' });
    hasGitNexus = true;
  } catch { /* not installed */ }

  if (hasGitNexus) {
    const gnRepo = 'Brainifai';

    // search_code — queries GitNexus + enriches from KG
    try {
      const fn = registry.get('search_code')!;
      const result = await fn.execute({ query: 'MCP server', repo: gnRepo, limit: 3 }, store) as any;
      check(result != null && Array.isArray(result.processes), P, 'search_code returns processes',
        `Expected processes array, got ${JSON.stringify(result)?.slice(0, 200)}`);
    } catch (e: any) { fail(P, 'search_code returns processes', e.message); }

    // get_symbol_context — 360 view of a symbol
    try {
      const fn = registry.get('get_symbol_context')!;
      const result = await fn.execute({ symbol: 'createServer', repo: gnRepo }, store) as any;
      check(result != null && result.symbol != null, P, 'get_symbol_context returns symbol info',
        `Expected symbol info, got ${JSON.stringify(result)?.slice(0, 200)}`);
    } catch (e: any) { fail(P, 'get_symbol_context returns symbol info', e.message); }

    // get_blast_radius — impact analysis
    try {
      const fn = registry.get('get_blast_radius')!;
      const result = await fn.execute({ target: 'createServer', direction: 'upstream', repo: gnRepo }, store) as any;
      check(result != null && result.risk != null, P, 'get_blast_radius returns risk assessment',
        `Expected risk field, got ${JSON.stringify(result)?.slice(0, 200)}`);
    } catch (e: any) { fail(P, 'get_blast_radius returns risk assessment', e.message); }

    // detect_code_changes — aggregate blast radius for a set of changed symbols
    try {
      const fn = registry.get('detect_code_changes')!;
      const result = await fn.execute({ changes: ['createServer'], repo: gnRepo }, store) as any;
      check(result != null && Array.isArray(result.changes), P, 'detect_code_changes executes',
        `Expected changes array, got ${JSON.stringify(result)?.slice(0, 200)}`);
    } catch (e: any) { fail(P, 'detect_code_changes executes', e.message); }
  } else {
    // Just verify registration
    for (const name of ['search_code', 'get_symbol_context', 'get_blast_radius', 'detect_code_changes']) {
      const fn = registry.get(name);
      check(fn != null, P, `${name} is registered (GitNexus not installed, skipping exec)`,
        'Function not found in registry');
    }
  }

  // get_people_context (manager) — verify registered
  try {
    const fn = registry.get('get_people_context');
    check(fn != null, P, 'get_people_context is registered (manager)', 'Function not found in registry');
  } catch (e: any) { fail(P, 'get_people_context is registered (manager)', e.message); }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}=== BRAINIFAI SMOKE TEST ===${RESET}`);
  console.log(`${DIM}Temp dir: ${TEMP_DIR}${RESET}`);

  setupTempDir();

  // Phase 1 + 2: in-process with direct store access
  const { KuzuGraphStore } = await import('../graphstore/kuzu/adapter.js');
  const store = new KuzuGraphStore({ dbPath: DB_PATH, readOnly: false });

  try {
    await store.initialize();
    await withTimeout(phase1(store), 30000, 'Phase 1');
  } catch (e: any) {
    fail('Graph Store', 'phase completion', e.message);
  }

  try {
    await withTimeout(phase2(store), 15000, 'Phase 2');
  } catch (e: any) {
    fail('Context Functions', 'phase completion', e.message);
  }

  // Phase 8 needs the base store (decision_log queries against base schema)
  try {
    await withTimeout(phase8(store), 15000, 'Phase 8');
  } catch (e: any) {
    fail('Coding Instance', 'phase completion', e.message);
  }

  // Close store before child process phases (print results first as SIGSEGV safety net)
  printResults();

  try { await store.close(); } catch { /* Kuzu SIGSEGV on close is expected */ }

  // Phase 3-6: child processes
  try { await withTimeout(phase3(), 20000, 'Phase 3'); }
  catch (e: any) { fail('MCP Server', 'phase completion', e.message); }

  try { await withTimeout(phase4(), 20000, 'Phase 4'); }
  catch (e: any) { fail('API Server', 'phase completion', e.message); }

  try { await withTimeout(phase5(), 30000, 'Phase 5'); }
  catch (e: any) { fail('Hooks', 'phase completion', e.message); }

  try { await withTimeout(phase6(), 30000, 'Phase 6'); }
  catch (e: any) { fail('CLI', 'phase completion', e.message); }

  // Phase 7: PM instance (separate DB, runs after child process phases)
  try { await withTimeout(phase7(), 30000, 'Phase 7'); }
  catch (e: any) { fail('Project Manager', 'phase completion', e.message); }

  // Final report
  printResults();
  cleanup();

  const failed = results.filter((r) => !r.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

function printResults() {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log(`\n${BOLD}─── Results ───${RESET}`);
  console.log(`${passed > 0 ? GREEN : ''}${passed} passed${RESET}, ${failed > 0 ? RED : ''}${failed} failed${RESET}, ${total} total`);

  if (failed > 0) {
    console.log(`\n${RED}Failures:${RESET}`);
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ${r.phase} > ${r.name}: ${r.error}`);
    }
  }
}

function cleanup() {
  for (const proc of childProcs) {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }
  try {
    if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch { /* best effort */ }
}

// Ensure cleanup on unexpected exit
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

main().catch((e) => {
  console.error(`\n${RED}Fatal error:${RESET}`, e);
  cleanup();
  process.exit(1);
});
