// Bail fast if disabled
if (process.env.BRAINIFAI_HOOKS === 'false') process.exit(0);

// Force read-only on-demand mode for the singleton standard graph store
process.env.GRAPHSTORE_ON_DEMAND = 'true';
process.env.GRAPHSTORE_READONLY = 'true';

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { getRecentActivity, type ActivityItem } from '../../src/mcp/queries/activity.js';
import type { InstanceConfig } from '../../src/instance/types.js';
import { ProjectManagerGraphStore } from '../../src/graphstore/kuzu/project-manager-adapter.js';
import {
  HOOK_TOTAL_BUDGET,
  HOOK_DECISION_SNIPPET_LEN,
  HOOK_SESSION_SNIPPET_LEN,
  HOOK_CROSS_PROJECT_SNIPPET_LEN,
  HOOK_PERSON_TOTAL_BUDGET,
  HOOK_PERSON_SNIPPET_LEN,
  HOOK_PERSON_ITEM_LIMIT,
  HOOK_PERSON_WINDOW_DAYS,
} from '../../src/shared/constants.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ProjectInfo {
  name: string;
  dir: string;
}

interface FoundInstance {
  instancePath: string;
  dbPath: string;
  config: InstanceConfig;
}

/**
 * A strategy receives the current project + the DB path for its matched instance,
 * and returns a formatted context section (or null if there's nothing to show).
 *
 * Adding a new instance type: add one entry to STRATEGIES — nothing else changes.
 */
type ContextStrategy = (
  project: ProjectInfo,
  branch: string,
  dbPath: string,
) => Promise<string | null>;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getProjectInfo(): ProjectInfo | null {
  const dir = process.env.CLAUDE_PROJECT_DIR;
  if (!dir) return null;
  const name = dir.split('/').filter(Boolean).pop() ?? '';
  return name ? { name, dir } : null;
}

function getGitBranch(dir: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: dir, timeout: 2000, encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function dedup(items: ActivityItem[]): ActivityItem[] {
  const seen = new Map<string, ActivityItem>();
  for (const item of items) {
    const key = stripAnsi(item.snippet).slice(0, 100);
    const existing = seen.get(key);
    if (!existing || item.timestamp > existing.timestamp) seen.set(key, item);
  }
  return [...seen.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function truncate(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const lines = text.split('\n');
  while (lines.length > 1 && lines.join('\n').length > budget) lines.pop();
  const joined = lines.join('\n');
  return joined.length > budget ? joined.slice(0, budget - 3) + '...' : joined;
}

/** Run a strategy with a hard timeout; returns null on timeout or error. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  const timer = new Promise<null>((res) => setTimeout(() => res(null), ms));
  try {
    return await Promise.race([p, timer]);
  } catch {
    return null;
  }
}

/** Write context JSON and exit immediately.
 *  Called process.exit(0) before Kuzu native cleanup can segfault. */
function emit(context: string): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }),
  );
  process.exit(0);
}

// ─── Instance Discovery ────────────────────────────────────────────────────────

const GLOBAL_INSTANCE_PATH = resolve(homedir(), '.brainifai');
const INSTANCE_CONFIG_FILE = 'config.json';

/** Instance types that use the standard Kuzu schema (Person/Activity/Topic/Container). */
const STANDARD_SCHEMA_TYPES = new Set(['coding', 'manager', 'general']);

function readInstanceConfig(instancePath: string): InstanceConfig | null {
  try {
    return JSON.parse(
      readFileSync(resolve(instancePath, INSTANCE_CONFIG_FILE), 'utf-8'),
    ) as InstanceConfig;
  } catch {
    return null;
  }
}

/**
 * Walk UP from startDir, collecting every .brainifai/ instance found —
 * excluding ~/.brainifai/ (global), which is always used as a fallback.
 * Returns instances ordered nearest-first.
 */
function findInstancesInAncestry(startDir: string): FoundInstance[] {
  const found: FoundInstance[] = [];
  let dir = resolve(startDir);
  const root = resolve('/');

  while (dir !== root) {
    const candidate = resolve(dir, '.brainifai');
    if (
      existsSync(resolve(candidate, INSTANCE_CONFIG_FILE)) &&
      candidate !== GLOBAL_INSTANCE_PATH
    ) {
      const config = readInstanceConfig(candidate);
      if (config) {
        found.push({
          instancePath: candidate,
          dbPath: resolve(candidate, 'data', 'kuzu'),
          config,
        });
      }
    }
    dir = dirname(dir);
  }
  return found;
}

// ─── Context mode ──────────────────────────────────────────────────────────────

type ContextMode = 'strategy' | 'person';

function getContextMode(projectDir?: string): ContextMode {
  const envMode = process.env.CONTEXT_MODE?.toLowerCase();
  if (envMode === 'person') return 'person';
  if (projectDir) {
    try {
      const cfgPath = resolve(projectDir, '.claude', 'brainifai.json');
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
        if (cfg.contextMode === 'person') return 'person';
      }
    } catch { /* ignore parse errors */ }
  }
  return 'strategy';
}

// ─── Person mode (holistic, cross-project — unchanged from original) ───────────

async function buildPersonContext(projectName: string, branch: string): Promise<string> {
  const items = dedup(
    await getRecentActivity({
      kinds: ['decision', 'insight', 'bug_fix', 'session_summary', 'preference'],
      windowDays: HOOK_PERSON_WINDOW_DAYS,
      limit: HOOK_PERSON_ITEM_LIMIT,
    }),
  );

  if (items.length === 0) {
    return `[Brainifai KG] No recent activity across projects.`;
  }

  const lines = [
    `[Brainifai KG] Holistic context (session in "${projectName}", branch: ${branch})`,
    '',
    '## Recent activity (all projects)',
    ...items.map(
      (i) =>
        `- [${i.timestamp.slice(0, 10)}] [${i.kind}] ${i.channel}: ` +
        stripAnsi(i.snippet).slice(0, HOOK_PERSON_SNIPPET_LEN),
    ),
  ];

  return truncate(lines.join('\n'), HOOK_PERSON_TOTAL_BUDGET);
}

// ─── Strategies ────────────────────────────────────────────────────────────────

/**
 * coding — decisions, bug fixes, session summaries, cross-project.
 * This is the original project-mode behaviour, preserved exactly.
 * Uses the singleton standard-schema graphstore (KUZU_DB_PATH must be set).
 */
async function buildCodingContext(
  project: ProjectInfo,
  _branch: string,
  _dbPath: string,
): Promise<string | null> {
  const [decisions, sessions, crossProject] = await Promise.all([
    getRecentActivity({
      containerName: project.name,
      kinds: ['decision', 'insight', 'bug_fix'],
      windowDays: 30,
      limit: 5,
    }),
    getRecentActivity({
      containerName: project.name,
      kinds: ['session_summary'],
      windowDays: 14,
      limit: 5,
    }),
    getRecentActivity({
      kinds: ['decision', 'insight', 'bug_fix', 'preference'],
      windowDays: 7,
      limit: 5,
    }),
  ]);

  const ddec = dedup(decisions);
  const dses = dedup(sessions);
  const dcross = dedup(crossProject.filter((i) => i.channel !== project.name));

  if (!ddec.length && !dses.length && !dcross.length) return null;

  const lines: string[] = ['## Code context'];
  if (ddec.length) {
    lines.push('', '### Key decisions (last 30d)');
    ddec.forEach((d) =>
      lines.push(
        `- [${d.timestamp.slice(0, 10)}] [${d.kind}] ` +
          stripAnsi(d.snippet).slice(0, HOOK_DECISION_SNIPPET_LEN),
      ),
    );
  }
  if (dses.length) {
    lines.push('', '### Recent work');
    dses.forEach((s) =>
      lines.push(
        `- [${s.timestamp.slice(0, 10)}] ` + stripAnsi(s.snippet).slice(0, HOOK_SESSION_SNIPPET_LEN),
      ),
    );
  }
  if (dcross.length) {
    lines.push('', '### Across projects');
    dcross.forEach((c) =>
      lines.push(
        `- [${c.timestamp.slice(0, 10)}] [${c.kind}] ${c.channel}: ` +
          stripAnsi(c.snippet).slice(0, HOOK_CROSS_PROJECT_SNIPPET_LEN),
      ),
    );
  }
  return lines.join('\n');
}

/**
 * manager — Slack conversations, meetings, ClickUp tasks, people context.
 * Uses the singleton standard-schema graphstore.
 */
async function buildManagerContext(
  project: ProjectInfo,
  _branch: string,
  _dbPath: string,
): Promise<string | null> {
  const [convos, tasks] = await Promise.all([
    getRecentActivity({
      containerName: project.name,
      kinds: ['message', 'meeting'],
      windowDays: 7,
      limit: 5,
    }),
    getRecentActivity({
      containerName: project.name,
      kinds: ['task_update', 'decision'],
      windowDays: 14,
      limit: 5,
    }),
  ]);

  const dc = dedup(convos);
  const dt = dedup(tasks);
  if (!dc.length && !dt.length) return null;

  const lines: string[] = ['## Team context'];
  if (dc.length) {
    lines.push('', '### Recent conversations & meetings');
    dc.forEach((c) =>
      lines.push(
        `- [${c.timestamp.slice(0, 10)}] [${c.kind}] ${c.person}: ` +
          stripAnsi(c.snippet).slice(0, 150),
      ),
    );
  }
  if (dt.length) {
    lines.push('', '### Tasks & decisions');
    dt.forEach((t) =>
      lines.push(
        `- [${t.timestamp.slice(0, 10)}] [${t.kind}] ` + stripAnsi(t.snippet).slice(0, 150),
      ),
    );
  }
  return lines.join('\n');
}

/**
 * project-manager — health score, recent commits, Claude sessions,
 * cross-project relations, open tasks.
 *
 * Opens ProjectManagerGraphStore directly at the instance dbPath —
 * does NOT use the singleton standard-schema store.
 */
async function buildProjectManagerContext(
  project: ProjectInfo,
  _branch: string,
  dbPath: string,
): Promise<string | null> {
  if (!existsSync(dbPath)) return null;

  const store = new ProjectManagerGraphStore({ dbPath, readOnly: true });

  // initialize() loads the FTS extension (needed for FTS queries) then runs
  // CREATE TABLE IF NOT EXISTS DDL. The DDL fails in read-only mode on an
  // already-initialized DB, but by then the FTS extension is already loaded.
  try {
    await store.initialize();
  } catch { /* schema already exists — FTS extension was loaded, continue */ }

  // Check if the current project exists in the PM graph
  const health = await store.getProjectHealth(project.name).catch(() => null);

  // If no match, show a portfolio overview instead of single-project context
  if (!health) {
    return buildPortfolioOverview(store);
  }

  return buildSingleProjectContext(store, project, health);
}

/** Portfolio-level overview when not inside a specific project (e.g. ~/Projects). */
async function buildPortfolioOverview(
  store: InstanceType<typeof ProjectManagerGraphStore>,
): Promise<string | null> {
  const [allProjects, stale] = await Promise.all([
    store.query(
      `MATCH (p:Project)
       RETURN p.name AS name, p.health_score AS health, p.language AS lang, p.framework AS fw, p.updated_at AS updated
       ORDER BY p.updated_at DESC`,
    ).catch(() => []),
    store.findStaleProjects(30).catch(() => []),
  ]);

  if (!allProjects.length) return null;

  const lines: string[] = ['## Portfolio overview'];

  // Group by health
  const byHealth: Record<string, string[]> = {};
  for (const p of allProjects) {
    const h = (p.health as string) || 'unknown';
    (byHealth[h] ??= []).push(
      `${p.name} (${[p.lang, p.fw].filter(Boolean).join('/')})`,
    );
  }

  lines.push(`${allProjects.length} projects tracked\n`);

  for (const tier of ['excellent', 'good', 'fair', 'poor', 'unknown']) {
    const projects = byHealth[tier];
    if (!projects?.length) continue;
    lines.push(`**${tier}** (${projects.length}): ${projects.slice(0, 6).join(', ')}${projects.length > 6 ? ', ...' : ''}`);
  }

  // Stale projects needing attention
  if (stale.length) {
    lines.push('', '### Needs attention');
    stale.slice(0, 5).forEach((s) => {
      lines.push(`- ${s.project.name} — ${s.days_inactive}d inactive`);
    });
  }

  // Recent activity across all projects
  const recentCommits = await store.query(
    `MATCH (c:Commit)-[:COMMITTED_TO]->(p:Project)
     RETURN p.name AS project, c.message AS msg, c.date AS date
     ORDER BY c.date DESC LIMIT 5`,
  ).catch(() => []);

  if (recentCommits.length) {
    lines.push('', '### Recent commits (all projects)');
    recentCommits.forEach((c) => {
      lines.push(`- [${(c.date as string)?.slice(0, 10)}] ${c.project}: ${(c.msg as string)?.split('\n')[0].slice(0, 70)}`);
    });
  }

  return lines.join('\n');
}

/** Single-project context when inside a known project directory. */
async function buildSingleProjectContext(
  store: InstanceType<typeof ProjectManagerGraphStore>,
  project: ProjectInfo,
  health: Awaited<ReturnType<InstanceType<typeof ProjectManagerGraphStore>['getProjectHealth']>>,
): Promise<string | null> {
  const [activity, impact] = await Promise.all([
    store
      .getProjectActivity(project.name, { windowDays: 14, limit: 5 })
      .catch(() => ({ project_slug: project.name, commits: [], sessions: [], tasks: [] })),
    store
      .getCrossProjectImpact(project.name, 1)
      .catch(() => ({ source_slug: project.name, affected_projects: [] })),
  ]);

  const lines: string[] = ['## Project portfolio'];

  // ── Health & staleness ──────────────────────────────────────────────────
  if (health) {
    const h = health.project;
    const badge = h.health_score ? ` [${h.health_score}]` : '';
    const lang =
      [h.language, h.framework].filter(Boolean).join(' / ');
    lines.push('', `### ${h.name}${badge}${lang ? ` · ${lang}` : ''}`);

    if (health.days_since_last_commit !== null) {
      lines.push(`Last commit: ${health.days_since_last_commit}d ago`);
    }
    if (health.stale_deps_count > 0) {
      lines.push(`Outdated deps: ${health.stale_deps_count}`);
    }

    const staleBranches = health.branches.filter(
      (b) =>
        !b.is_default &&
        b.last_commit_date &&
        Date.now() - new Date(b.last_commit_date).getTime() > 30 * 24 * 60 * 60 * 1000,
    );
    if (staleBranches.length) {
      lines.push(`Stale branches: ${staleBranches.map((b) => b.name).slice(0, 3).join(', ')}`);
    }
  }

  // ── Recent commits ──────────────────────────────────────────────────────
  if (activity.commits.length) {
    lines.push('', '### Recent commits (14d)');
    activity.commits.slice(0, 4).forEach((c) => {
      lines.push(`- [${c.date}] ${c.message.split('\n')[0].slice(0, 80)}`);
    });
  }

  // ── Recent Claude sessions ──────────────────────────────────────────────
  if (activity.sessions.length) {
    lines.push('', '### Recent Claude sessions (14d)');
    activity.sessions.slice(0, 3).forEach((s) => {
      if (s.summary) lines.push(`- [${s.date}] ${s.summary.slice(0, 120)}`);
    });
  }

  // ── Related projects ────────────────────────────────────────────────────
  if (impact.affected_projects.length) {
    lines.push('', '### Related projects');
    impact.affected_projects.slice(0, 5).forEach((p) => {
      lines.push(`- ${p.name} (${p.relation})`);
    });
  }

  // ── Open tasks ──────────────────────────────────────────────────────────
  const openTasks = activity.tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'closed',
  );
  if (openTasks.length) {
    lines.push('', '### Open tasks');
    openTasks.slice(0, 3).forEach((t) => {
      lines.push(`- ${t.title}${t.priority ? ` [${t.priority}]` : ''}`);
    });
  }

  return lines.join('\n');
}

/**
 * general — broad fallback; delegates to the coding strategy.
 */
const buildGeneralContext: ContextStrategy = buildCodingContext;

// ─── Strategy registry ─────────────────────────────────────────────────────────
// To add a new instance type: add one entry here. Core dispatch logic is untouched.

const STRATEGIES: Record<string, ContextStrategy> = {
  coding: buildCodingContext,
  manager: buildManagerContext,
  'project-manager': buildProjectManagerContext,
  general: buildGeneralContext,
  // EHR contains clinical data with no session-start context relevance
  ehr: async () => null,
};

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const project = getProjectInfo();
  if (!project) process.exit(0); // No project dir → nothing to inject

  const branch = getGitBranch(project.dir);
  const mode = getContextMode(project.dir);

  // ── Person mode override ────────────────────────────────────────────────────
  // Explicit opt-in; bypasses strategy dispatch entirely.
  // Point the singleton at the global standard KG for holistic cross-project queries.
  if (mode === 'person') {
    process.env.KUZU_DB_PATH = resolve(GLOBAL_INSTANCE_PATH, 'data', 'kuzu');
    const ctx = await buildPersonContext(project.name, branch);
    emit(ctx);
  }

  // ── Strategy mode ───────────────────────────────────────────────────────────

  // 1. Discover all .brainifai/ instances in the directory ancestry
  const allInstances = findInstancesInAncestry(project.dir);

  // 2. Separate standard-schema instances from specialised ones
  const nearestStandard = allInstances.find((i) => STANDARD_SCHEMA_TYPES.has(i.config.type));
  const specializedInstances = allInstances.filter(
    (i) => !STANDARD_SCHEMA_TYPES.has(i.config.type),
  );

  // 3. Standard strategies (coding/manager/general) use the singleton graphstore.
  //    Point KUZU_DB_PATH at the nearest standard-schema instance, or the global
  //    standard KG as a fallback.  This must be set before any getRecentActivity()
  //    call so the singleton opens the right DB.
  const standardDbPath =
    nearestStandard?.dbPath ?? resolve(GLOBAL_INSTANCE_PATH, 'data', 'kuzu');
  process.env.KUZU_DB_PATH = standardDbPath;

  // 4. Build the task list — run everything in parallel
  const tasks: Array<Promise<string | null>> = [];

  if (existsSync(standardDbPath)) {
    const strategy =
      STRATEGIES[nearestStandard?.config.type ?? 'coding'] ?? buildCodingContext;
    tasks.push(withTimeout(strategy(project, branch, standardDbPath), 3000));
  }

  for (const inst of specializedInstances) {
    const strategy = STRATEGIES[inst.config.type];
    if (strategy) tasks.push(withTimeout(strategy(project, branch, inst.dbPath), 3000));
  }

  if (tasks.length === 0) process.exit(0);

  // 5. Await all strategies; filter nulls; combine sections
  const results = await Promise.all(tasks);
  const sections = results.filter((r): r is string => r !== null);

  if (sections.length === 0) process.exit(0);

  const header = `[Brainifai KG] Context for "${project.name}" (branch: ${branch})`;
  const context = truncate(
    `${header}\n\n${sections.join('\n\n')}`,
    HOOK_TOTAL_BUDGET,
  );

  emit(context);
}

main().catch(() => process.exit(0));
