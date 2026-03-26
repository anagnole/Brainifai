# Brainifai

A federated Personal Knowledge Graph (PKG) system. Data flows in from your work tools, gets routed by an AI orchestrator to specialized graph instances, and is served to Claude sessions via MCP.

## How it works

```
Slack / GitHub / ClickUp / Apple Calendar / Claude Code sessions
   |  fetch + normalize (incremental, cursor-based)
   v
Global Instance (~/.brainifai/)
   |  Ingestion pipeline -> MERGE into Kuzu (idempotent)
   |  AI Orchestrator (Claude Haiku) classifies + routes to children
   |  Event Bus (data.push)
   v
   +-- Coding Instance        -> PR context, decision logs, GitNexus code intelligence
   +-- Manager Instance       -> people context, meeting summaries
   +-- Project Manager        -> cross-project health, dependencies, Claude session history
   +-- EHR Instance           -> clinical queries (patients, meds, labs, conditions)
   +-- General Instance       -> broad cross-topic search
   v
MCP Servers (stdio, per-instance)
   v
Claude Sessions (Desktop or Claude Code)
```

Each instance has its own Kuzu database, its own set of context functions, and its own MCP server entry. Instances self-describe via `config.json` so the orchestrator knows where to route data.

## Architecture

```
src/
  api/              Fastify REST API (graph visualization, ingestion triggers)
  cli/              CLI commands (init, status, list, describe, doctor, remove, ingest)
  context/          Context function registry, per-instance resolution
    functions/      Base tools + coding bridge + EHR + project-manager
  event-bus/        File-based pub/sub for inter-instance messaging
  graphstore/       Kuzu adapter, on-demand wrapper, EHR + project-manager schemas
  hooks/            PreToolUse (KG context injection), SessionStart
  ingestion/        Slack, GitHub, ClickUp, Apple Calendar, Claude Code, project-manager
  instance/         Instance model, templates, init, resolve, lifecycle, skill generator
  mcp/              MCP server, instance-aware tool registration
  orchestrator/     AI classifier, router, data delivery (Claude Haiku subprocess)
  shared/           Constants, logger, graphstore singleton
  viz/              React + Sigma.js graph visualization UI
  scripts/          Utilities (test-connection, seed-schema)
bin/
  brainifai.js      CLI entrypoint
```

## Data sources

| Source | What's ingested |
|--------|----------------|
| **Slack** | Channel messages, threads, reactions |
| **GitHub** | PRs, reviews, comments |
| **ClickUp** | Tasks, comments, status changes, docs |
| **Apple Calendar** | CalDAV events from iCloud |
| **Claude Code** | Session files, conversation summaries |
| **Git repos** | Commits, branches, dependencies (auto-scanned from ~/Projects) |

All sources are optional — each is skipped if its credentials are not set. Ingestion is incremental and cursor-based.

## Graph model

**Base schema** (all instances):

| Node | Key | Represents |
|------|-----|------------|
| `Person` | `person_key` | A human across sources (`slack:U123`, `github:user`) |
| `Activity` | `(source, source_id)` | A message, PR, task, or calendar event |
| `Topic` | `name` | A keyword, hashtag, or label |
| `Container` | `(source, container_id)` | A channel, repo, list, or calendar |

**EHR schema** (clinical instances):

| Node | Key | Represents |
|------|-----|------------|
| `Patient` | `patient_id` | Demographics, birthdate, gender |
| `Encounter` | `encounter_id` | A clinical visit |
| `Condition` | `condition_id` | Diagnosis with onset/resolution dates |
| `Medication` | `medication_id` | Prescription with start/stop dates |
| `Observation` | `observation_id` | Lab result with value and units |
| `Procedure` | `procedure_id` | Clinical procedure with date |
| `Provider` | `provider_id` | Clinician or organization |

**Project Manager schema**:

| Node | Key | Represents |
|------|-----|------------|
| `Project` | `project_id` | A git repository with health scoring |
| `Commit` | `commit_id` | A git commit |
| `Dependency` | `dep_id` | Package dependency between projects |

## Instance types

Instances are bootstrapped from templates that configure which context functions are active:

| Type | Sources | Context functions |
|------|---------|-------------------|
| **coding** | GitHub, Claude Code | Base 5 + `search_code`, `get_symbol_context`, `get_blast_radius`, `detect_code_changes`, `get_pr_context`, `get_decision_log` |
| **manager** | Slack, Calendar, ClickUp | Base 5 + `get_people_context`, `get_meeting_summary` |
| **project-manager** | Git repos (auto-scanned) | `search_projects`, `get_project_health`, `get_project_activity`, `get_cross_project_impact`, `find_stale_projects`, `get_dependency_graph`, `get_claude_session_history` |
| **ehr** | Static clinical data | `search_patients`, `get_patient_summary`, `get_medications`, `get_diagnoses`, `get_labs`, `get_temporal_relation`, `find_cohort` |
| **general** | All sources | Base 5 (broad context, cross-topic) |

Base tools (all non-EHR instances): `search_entities`, `get_entity_summary`, `get_recent_activity`, `get_context_packet`, `ingest_memory`.

The **coding** instance bridges to [GitNexus](https://github.com/anagnole/gitnexus) for code intelligence — symbol context, call chains, and blast radius analysis.

## Setup

### Prerequisites

- Node.js 20+

### Install

```bash
git clone https://github.com/anagnole/Brainifai.git
cd Brainifai
npm install
cp .env.example .env
```

### Configure sources

Edit `.env` with your credentials. All sources are optional.

| Variable | Description |
|----------|-------------|
| `KUZU_DB_PATH` | Override default DB path (`~/.brainifai/data/kuzu`) |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_CHANNEL_IDS` | Comma-separated Slack channel IDs |
| `GITHUB_TOKEN` | GitHub personal access token |
| `GITHUB_REPOS` | Comma-separated repos (`owner/repo`) |
| `CLICKUP_TOKEN` | ClickUp API token |
| `CLICKUP_LIST_IDS` | Comma-separated ClickUp list IDs |
| `APPLE_CALDAV_USERNAME` | iCloud email for CalDAV |
| `APPLE_CALDAV_PASSWORD` | App-specific password ([generate here](https://appleid.apple.com)) |
| `APPLE_CALDAV_CALENDARS` | Calendar names to sync (empty = all) |
| `BACKFILL_DAYS` | Days to backfill on first run (default: `7`) |
| `TOPIC_ALLOWLIST` | Comma-separated keywords for topic extraction |

### CLI

```bash
bin/brainifai.js init                    # Create global instance (~/.brainifai/)
bin/brainifai.js init --type coding      # Create project instance in cwd
bin/brainifai.js status                  # Show instance health
bin/brainifai.js list                    # List all instances
bin/brainifai.js doctor                  # Diagnose connectivity issues
```

### Run

```bash
npm run ingest              # Fetch new data, upsert to graph
npm run mcp                 # Start MCP server (stdio)
npm run schema              # Create/update graph indexes
npm run test-connection     # Verify DB connectivity
npm test                    # Run tests (vitest)
npm run viz:dev             # Dev server (API at :4200, UI at :4201)
npm run viz                 # Production build + serve
```

## Using with Claude

### Claude Code / Claude Desktop

The global MCP server is configured in `~/.claude/settings.json`. For project-specific instances, add a `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "brainifai": {
      "command": "npx",
      "args": ["tsx", "--env-file=.env", "src/mcp/index.ts"],
      "cwd": "/path/to/Brainifai",
      "env": {
        "GRAPHSTORE_ON_DEMAND": "true",
        "GRAPHSTORE_READONLY": "true",
        "KUZU_DB_PATH": "/path/to/project/.brainifai/data/kuzu",
        "BRAINIFAI_INSTANCE_PATH": "/path/to/project/.brainifai"
      }
    }
  }
}
```

### Hooks

Brainifai includes Claude Code hooks for automatic context enrichment:

- **PreToolUse** — injects relevant KG context before Claude uses a tool
- **SessionStart** — initializes session-scoped context from the graph

## Multi-instance architecture

The system is built around a tree of instances coordinated by a global orchestrator:

- **Global instance** (`~/.brainifai/`) — ingests from all external sources, maintains a registry of children, runs the orchestrator
- **Project instances** (`<project>/.brainifai/`) — specialized DBs and tools scoped to a project
- **Event bus** — file-based pub/sub for `data.push`, `instance.registered`, `query.request/response` messages
- **Orchestrator** — AI-powered classifier (Claude Haiku subprocess) that reads instance descriptions and routes ingested data to matching children
- **Context functions** — composable, per-instance tools registered in a global registry and activated based on instance config/template
- **Skill generator** — auto-generates Claude Code skills from an instance's active context functions

## Key design decisions

- All ingestion uses `MERGE` — safe to re-run, no duplicates
- Cursors stored in graph DB — wipe DB = clean re-backfill
- MCP exposes curated tools only, no raw Cypher to the LLM
- Safety limits: `MAX_EVIDENCE=20`, `MAX_TOTAL_CHARS=8000`, `QUERY_TIMEOUT=10s`
- Kuzu (embedded) — no Docker, no external DB process
- OnDemand graph store for MCP/hooks — avoids write lock contention with ingestion
- Each instance self-describes so the orchestrator can route without hardcoded rules
- Cross-source identity resolution links the same person across Slack, GitHub, and email

## Tech stack

- **Runtime**: TypeScript (ESM), Node.js 20+
- **Graph DB**: [Kuzu](https://kuzudb.com) (embedded, no server)
- **MCP**: `@modelcontextprotocol/sdk` (stdio transport)
- **API**: Fastify + WebSocket
- **Visualization**: React 19, Sigma.js v3, Graphology
- **CLI**: Commander
- **Testing**: Vitest
- **Sources**: Slack Web API, Octokit, tsdav (CalDAV), ClickUp REST API

## License

MIT
