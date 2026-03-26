/**
 * Generates a .claude/skills/brainifai/SKILL.md file in the project directory
 * after `brainifai init` so the instance capabilities are immediately available
 * to Claude Code sessions without any extra setup.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

/** Absolute path to the Brainifai package root (two levels up from src/instance/) */
const BRAINIFAI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface SkillGenOptions {
  instancePath: string;   // absolute path to .brainifai/
  projectPath: string;    // absolute path to the project root
  name: string;
  type: string;
  description: string;
}

/** Write .claude/skills/brainifai/SKILL.md in the project directory */
export function generateInstanceSkill(opts: SkillGenOptions): void {
  const { instancePath, projectPath, name, type, description } = opts;
  const dbPath = resolve(instancePath, 'data', 'kuzu');
  const skillDir = resolve(projectPath, '.claude', 'skills', 'brainifai');

  mkdirSync(skillDir, { recursive: true });

  const content = buildSkillContent({ name, type, description, dbPath, brainifaiRoot: BRAINIFAI_ROOT });
  writeFileSync(resolve(skillDir, 'SKILL.md'), content, 'utf-8');
}

// ─── Per-type skill builders ───────────────────────────────────────────────────

interface SkillParams {
  name: string;
  type: string;
  description: string;
  dbPath: string;
  brainifaiRoot: string;
}

function buildSkillContent(p: SkillParams): string {
  switch (p.type) {
    case 'project-manager': return buildProjectManagerSkill(p);
    case 'coding':          return buildCodingSkill(p);
    case 'manager':         return buildManagerSkill(p);
    case 'ehr':             return buildEhrSkill(p);
    default:                return buildGeneralSkill(p);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Inline tsx one-liner for project-manager queries */
function pmScript(dbPath: string, brainifaiRoot: string, body: string): string {
  const tsx = resolve(brainifaiRoot, 'node_modules/.bin/tsx');
  // Escape backticks inside body just in case
  const safeBody = body.replace(/`/g, '\\`');
  return [
    '```bash',
    `${tsx} --tsconfig ${resolve(brainifaiRoot, 'tsconfig.json')} -e "`,
    `import { ProjectManagerGraphStore } from '${resolve(brainifaiRoot, 'src/graphstore/kuzu/project-manager-adapter.js')}';`,
    `const store = new ProjectManagerGraphStore({ dbPath: '${dbPath}', readOnly: true });`,
    safeBody,
    `await store.close();`,
    '"',
    '```',
  ].join('\n');
}

// ─── project-manager ──────────────────────────────────────────────────────────

function buildProjectManagerSkill(p: SkillParams): string {
  const { name, description, dbPath, brainifaiRoot } = p;
  const tsx = resolve(brainifaiRoot, 'node_modules/.bin/tsx');
  const adapter = resolve(brainifaiRoot, 'src/graphstore/kuzu/project-manager-adapter.js');
  const tsconfig = resolve(brainifaiRoot, 'tsconfig.json');

  const script = (body: string) => [
    '```bash',
    `${tsx} --tsconfig ${tsconfig} -e "`,
    `import { ProjectManagerGraphStore } from '${adapter}';`,
    `const s = new ProjectManagerGraphStore({ dbPath: '${dbPath}', readOnly: true });`,
    body,
    `await s.close();`,
    '"',
    '```',
  ].join('\n');

  return `---
name: brainifai
description: "Brainifai project-manager instance \\"${name}\\" — search projects, check health, find stale repos, view dependencies and Claude session history"
---

# Brainifai — Project Manager

This directory has a Brainifai **project-manager** instance named **"${name}"**.

> ${description}

**DB:** \`${dbPath}\`

Use the bash scripts below to query project data directly. Results are JSON — pipe through \`| python3 -m json.tool\` or \`| jq\` for readable output.

---

## Search projects

Find projects by name, language, or keyword:

${script(`const results = await s.searchProjects(process.argv[2] ?? '');
console.log(JSON.stringify(results, null, 2));`)}

**Usage:** append a search term as the last argument, e.g. \`... "react"\`

---

## Project health

Full health report for one project (commits, branches, deps, stale count):

${script(`const slug = process.argv[2] ?? '';
if (!slug) { console.error('Usage: ... <project-slug>'); process.exit(1); }
const report = await s.getProjectHealth(slug);
console.log(JSON.stringify(report, null, 2));`)}

---

## Recent activity

Commits, Claude sessions, and tasks for a project over the last N days:

${script(`const [slug, days, limit] = [process.argv[2], Number(process.argv[3] ?? 30), Number(process.argv[4] ?? 20)];
if (!slug) { console.error('Usage: ... <slug> [days] [limit]'); process.exit(1); }
const activity = await s.getProjectActivity(slug, days, limit);
console.log(JSON.stringify(activity, null, 2));`)}

---

## Stale projects

Find repos with no commit activity in the last N days (default 30):

${script(`const days = Number(process.argv[2] ?? 30);
const stale = await s.findStaleProjects(days);
console.log(JSON.stringify(stale, null, 2));`)}

---

## Cross-project impact

Which projects depend on (or are depended on by) a given project:

${script(`const slug = process.argv[2] ?? '';
const depth = Number(process.argv[3] ?? 2);
if (!slug) { console.error('Usage: ... <slug> [depth]'); process.exit(1); }
const impact = await s.getCrossProjectImpact(slug, depth);
console.log(JSON.stringify(impact, null, 2));`)}

---

## Dependency graph

Full dependency graph with version mismatch detection:

${script(`const filter = process.argv[2]; // optional project slug filter
const graph = await s.getDependencyGraph(filter);
console.log(JSON.stringify(graph, null, 2));`)}

---

## Claude session history

Recent Claude Code sessions for a project:

${script(`const [slug, days, limit] = [process.argv[2], Number(process.argv[3] ?? 90), Number(process.argv[4] ?? 20)];
if (!slug) { console.error('Usage: ... <slug> [days] [limit]'); process.exit(1); }
const sessions = await s.getClaudeSessionHistory(slug, days, limit);
console.log(JSON.stringify(sessions, null, 2));`)}
`;
}

// ─── coding ───────────────────────────────────────────────────────────────────

function buildCodingSkill(p: SkillParams): string {
  const { name, description, dbPath } = p;
  return `---
name: brainifai
description: "Brainifai coding instance \\"${name}\\" — code decisions, PR history, Claude session activity, and cross-instance knowledge graph"
---

# Brainifai — Coding Instance

This directory has a Brainifai **coding** instance named **"${name}"**.

> ${description}

**DB:** \`${dbPath}\`

## Available context via MCP tools

The global Brainifai MCP server is configured in \`~/.claude/settings.json\` and provides these tools. They auto-resolve to this instance when Claude Code is running in this directory.

| Tool | Use for |
|------|---------|
| \`get_context_packet\` | Primary tool — resolves a query to anchors, gathers structured facts + time-windowed evidence |
| \`search_entities\` | Full-text search across all entities (people, topics, containers) |
| \`get_entity_summary\` | Deep summary for one entity (activity timeline, related topics, recent work) |
| \`get_recent_activity\` | What happened in this codebase in the last N days |

## Workflow

When starting work on a feature or bug:
1. \`get_context_packet({ query: "feature or symbol name" })\` — get anchored context
2. \`get_recent_activity({ days: 14 })\` — see what changed recently
3. \`get_entity_summary({ entity_id: "..." })\` — deep-dive on a person or topic

## GitNexus integration

This instance is paired with GitNexus code intelligence. For code-specific queries use the GitNexus MCP tools alongside Brainifai for full context:
- GitNexus: call graphs, blast radius, symbol context
- Brainifai: decisions, sessions, PR outcomes, cross-team context
`;
}

// ─── manager ─────────────────────────────────────────────────────────────────

function buildManagerSkill(p: SkillParams): string {
  const { name, description, dbPath } = p;
  return `---
name: brainifai
description: "Brainifai manager instance \\"${name}\\" — Slack conversations, calendar context, task tracking, people relationships"
---

# Brainifai — Manager Instance

This directory has a Brainifai **manager** instance named **"${name}"**.

> ${description}

**DB:** \`${dbPath}\`

## Available context via MCP tools

| Tool | Use for |
|------|---------|
| \`get_context_packet\` | Primary tool — anchored context from Slack, calendar, tasks |
| \`search_entities\` | Find people, topics, projects, channels |
| \`get_entity_summary\` | Full profile for a person or topic (messages, meetings, tasks) |
| \`get_recent_activity\` | What happened across channels and calendar this week |

## Workflow

Before a meeting or decision:
1. \`get_context_packet({ query: "meeting topic or person name" })\` — pre-meeting brief
2. \`search_entities({ query: "person name" })\` — find the right entity ID
3. \`get_entity_summary({ entity_id: "..." })\` — full person profile with recent activity
`;
}

// ─── ehr ─────────────────────────────────────────────────────────────────────

function buildEhrSkill(p: SkillParams): string {
  const { name, description, dbPath } = p;
  return `---
name: brainifai
description: "Brainifai EHR instance \\"${name}\\" — patient records, encounters, conditions, medications, labs, procedures"
---

# Brainifai — EHR Instance

This directory has a Brainifai **EHR** instance named **"${name}"**.

> ${description}

**DB:** \`${dbPath}\`

## Available context functions

| Function | Use for |
|----------|---------|
| \`search_patients\` | Find patients by name, ID, or demographic |
| \`get_patient_summary\` | Full clinical summary — conditions, meds, recent encounters |
| \`get_medications\` | Current and historical medications for a patient |
| \`get_diagnoses\` | Active and resolved diagnoses |
| \`get_labs\` | Lab results, trends, critical values |
| \`get_temporal_relation\` | Timeline of events for a patient |
| \`find_cohort\` | Find patients matching clinical criteria |

Use these through the MCP server or the \`get_context_packet\` tool with a patient-centric query.
`;
}

// ─── general ─────────────────────────────────────────────────────────────────

function buildGeneralSkill(p: SkillParams): string {
  const { name, description, dbPath } = p;
  return `---
name: brainifai
description: "Brainifai instance \\"${name}\\" (${p.type}) — knowledge graph with people, topics, activities from connected sources"
---

# Brainifai — ${p.type.charAt(0).toUpperCase() + p.type.slice(1)} Instance

This directory has a Brainifai **${p.type}** instance named **"${name}"**.

> ${description}

**DB:** \`${dbPath}\`

## Available context via MCP tools

| Tool | Use for |
|------|---------|
| \`get_context_packet\` | Primary tool — anchored context query across all ingested data |
| \`search_entities\` | Full-text search across entities |
| \`get_entity_summary\` | Deep summary for one entity |
| \`get_recent_activity\` | Recent activity across all sources |

The global Brainifai MCP server auto-resolves to this instance when Claude Code runs in this directory.
`;
}
