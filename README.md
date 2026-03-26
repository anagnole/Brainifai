# Brainifai

A federated Personal Knowledge Graph (PKG) system. Data flows in from your work tools, gets routed by an AI orchestrator to specialized graph instances, and is served to Claude sessions via MCP.

## How it works

```
Slack / GitHub / Calendar / ClickUp
   ↓  fetch + normalize (incremental, cursor-based)
Global Instance (~/.brainifai/)
   ↓  Ingestion pipeline → MERGE into Kuzu (idempotent)
   ↓  AI Orchestrator classifies data, routes to children
   ↓  Event Bus (data.push)
   ↓
   ├── Coding Instance     → PR summaries, decision logs
   ├── Manager Instance    → people context, meeting summaries
   ├── EHR Instance        → clinical queries (patients, meds, labs, conditions)
   └── General Instance    → broad cross-topic search
   ↓
MCP Servers (stdio, per-instance)
   ↓
Claude Sessions (Desktop or Claude Code)
```

Each instance has its own Kuzu database, its own set of context functions, and its own MCP server entry. Instances self-describe via `config.json` so the orchestrator knows where to route data.

## Architecture

```
src/
  context/          Context function registry, per-instance resolution
    functions/      Base tools + template-specific + EHR clinical tools
  event-bus/        File-based pub/sub for inter-instance messaging
  graphstore/       Kuzu adapter, on-demand wrapper, EHR schema
  hooks/            PreToolUse (KG context injection), SessionStart
  ingestion/        Slack/GitHub/Calendar connectors, normalize, upsert, cursor
  instance/         Instance model, templates, init, resolve, lifecycle
  mcp/              MCP server, instance-aware tool registration
  orchestrator/     AI classifier, router, data delivery
  shared/           Constants, logger, graphstore singleton
  api/              Fastify API server (graph visualization)
  viz/              React + Sigma.js graph visualization UI
  scripts/          Utilities (test-connection, seed-schema)
bin/
  brainifai.js      CLI entrypoint
```

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

## Instance types

Instances are bootstrapped from templates that configure which context functions are active:

| Type | Context functions |
|------|-------------------|
| **coding** | Base 5 + `get_pr_summary`, `get_decision_log` |
| **manager** | Base 5 + `get_people_context`, `get_meeting_summary` |
| **ehr** | `search_patients`, `get_patient_summary`, `get_medications`, `get_diagnoses`, `get_labs`, `get_temporal_relation`, `find_cohort` |
| **general** | Base 5 (broad context, cross-topic) |

Base tools available to all non-EHR instances: `search_entities`, `get_entity_summary`, `get_recent_activity`, `get_context_packet`, `ingest_memory`.

## Setup

### Prerequisites

- Node.js 20+

### Install

```bash
git clone <repo-url>
cd Brainifai
npm install
cp .env.example .env
```

### Configure sources

All sources are optional — each is skipped if its credentials are not set.

| Variable | Description |
|----------|-------------|
| `KUZU_DB_PATH` | Override default DB path (`~/.brainifai/data/kuzu`) |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_CHANNEL_IDS` | Comma-separated Slack channel IDs |
| `GITHUB_TOKEN` | GitHub personal access token |
| `GITHUB_REPOS` | Comma-separated repos (`owner/repo`) |
| `CLICKUP_TOKEN` | ClickUp API token |
| `CLICKUP_LIST_IDS` | Comma-separated ClickUp list IDs |
| `BACKFILL_DAYS` | Days to backfill on first run (default: `7`) |
| `TOPIC_ALLOWLIST` | Comma-separated keywords for topic extraction |

### Initialize

```bash
# Initialize the global instance (creates ~/.brainifai/)
bin/brainifai.js init

# Initialize a project instance
cd ~/Projects/MyProject
brainifai init --type coding --name my-project
```

### Run

```bash
npm run ingest              # Fetch new data, upsert to graph
npm run mcp                 # Start MCP server (stdio)
npm run schema              # Create/update graph indexes
npm run test-connection     # Verify DB connectivity
npx tsc --noEmit            # Type check
npm test                    # Run tests (vitest)
```

## Using with Claude

### Claude Code

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

The `BRAINIFAI_INSTANCE_PATH` env var tells the MCP server which instance to resolve, so it registers the correct context functions for that project.

## Multi-instance architecture

The system is built around a tree of instances coordinated by a global orchestrator:

- **Global instance** (`~/.brainifai/`) — ingests from all external sources, maintains a registry of children, runs the orchestrator
- **Project instances** (`<project>/.brainifai/`) — specialized DBs and tools scoped to a project
- **Event bus** — file-based pub/sub for `data.push`, `instance.registered`, `query.request/response` messages
- **Orchestrator** — AI-powered classifier (Claude Haiku) that reads instance descriptions and routes ingested data to matching children
- **Context functions** — composable, per-instance tools registered in a global registry and activated based on instance config/template

## Key design decisions

- All ingestion uses `MERGE` — safe to re-run, no duplicates
- Cursors stored in graph DB — wipe DB = clean re-backfill
- MCP exposes curated tools only, no raw Cypher to the LLM
- Safety limits: `MAX_EVIDENCE=20`, `MAX_TOTAL_CHARS=8000`, `QUERY_TIMEOUT=10s`
- Kuzu (embedded) — no Docker, no external DB process
- OnDemand graph store for MCP/hooks — avoids write lock contention with ingestion
- Each instance self-describes so the orchestrator can route without hardcoded rules
