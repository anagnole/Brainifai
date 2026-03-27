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

// ─── project-manager ──────────────────────────────────────────────────────────

function buildProjectManagerSkill(p: SkillParams): string {
  const { name, description } = p;

  return `---
name: brainifai
description: "Brainifai project-manager instance \\"${name}\\" — search projects, check health, find stale repos, view dependencies and Claude session history"
---

# Brainifai — Project Manager

This directory has a Brainifai **project-manager** instance named **"${name}"**.

> ${description}

## Available MCP Tools

Use these Brainifai MCP tools to query the project knowledge graph. They are available in every Claude Code session.

| Tool | What it does | Example |
|------|-------------|---------|
| \`search_projects\` | Full-text search across projects by name, description, or framework | \`search_projects({ query: "react" })\` |
| \`get_project_health\` | Health score, staleness, dependency freshness, commit/branch counts | \`get_project_health({ project_slug: "brainifai" })\` |
| \`get_project_activity\` | Recent commits, Claude sessions, and tasks for a project | \`get_project_activity({ project_slug: "alfred", window_days: 14 })\` |
| \`find_stale_projects\` | Find repos with no activity above a threshold | \`find_stale_projects({ days_threshold: 30 })\` |
| \`get_dependency_graph\` | Shared dependencies across projects, version mismatch detection | \`get_dependency_graph()\` or \`get_dependency_graph({ project_slug: "aballos" })\` |
| \`get_cross_project_impact\` | Multi-hop graph traversal — what's affected if a project changes | \`get_cross_project_impact({ project_slug: "claude-api", depth: 2 })\` |
| \`get_claude_session_history\` | Audit trail of Claude Code sessions for a project | \`get_claude_session_history({ project_slug: "brainifai" })\` |

## Workflow

### Getting oriented
1. \`search_projects({ query: "" })\` — list all tracked projects
2. \`find_stale_projects({ days_threshold: 30 })\` — see what needs attention

### Before working on a project
1. \`get_project_health({ project_slug: "..." })\` — health overview
2. \`get_project_activity({ project_slug: "...", window_days: 7 })\` — recent changes
3. \`get_cross_project_impact({ project_slug: "..." })\` — what depends on this

### Understanding the ecosystem
1. \`get_dependency_graph()\` — full cross-project dependency map
2. \`get_claude_session_history({ project_slug: "..." })\` — what Claude worked on

## Re-indexing

To refresh the project data, run from any terminal:

\`\`\`bash
cd ~/Projects && brainifai init --type project-manager --name ${name} --force
\`\`\`
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
