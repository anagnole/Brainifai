# Initialization & Config — Design Decisions

Status: decided on 2026-04-17. Covers directory layout, config schema, resolution, interactive init flow, and populate scripts.

## 1. Principles

- **Each folder has a single shared config file** listing all instances living in that folder. Instances under one folder share the config, not the DB.
- **Multi-instance-per-folder is first-class.** A folder can host `coding` + `researcher` simultaneously, each with its own DB.
- **Global is always explicit.** No auto-bootstrap — the user runs `brainifai init` once to create `~/.brainifai/`.
- **Config stays minimal.** No tunables bloat (no retention windows, buffer sizes, refinement intervals in config). Defaults live in code; users don't edit knobs.
- **Init is interactive, prompting for what the user needs to choose, not for what can be derived.**

## 2. Layout

```
~/.brainifai/                        # global (always exists)
  config.json
  general/
    data/kuzu/

<project>/.brainifai/                # project-level, multi-instance
  config.json                        # single shared config
  <instance-name-1>/
    data/kuzu/
  <instance-name-2>/
    data/kuzu/
```

Same shape everywhere — folder-level `config.json` wraps a list of instances; each instance has a subfolder with its own DB.

## 3. Config schema

```jsonc
{
  "version": 1,
  "instances": [
    {
      "name": "brainifai-coding",
      "type": "coding",
      "description": "...",
      "dbPath": "./brainifai-coding/data/kuzu",   // relative to .brainifai/
      "parent": "global",                          // instance name, or null
      "sources": [
        { "source": "github", "enabled": true },
        { "source": "claude-code", "enabled": true }
      ],
      "contextFunctions": [
        "search_code", "get_symbol_context", "..."
      ],
      "recentActivities": [
        { "timestamp": "...", "kind": "...", "snippet": "...", "topics": ["..."] }
      ],
      "createdAt": "2026-04-17T...",
      "updatedAt": "2026-04-17T..."
    },
    {
      "name": "brainifai-researcher",
      "type": "researcher",
      "...": "..."
    }
  ]
}
```

### Field notes

- `recentActivities` — small FIFO (~5 items), used for **peer visibility** (other instances and the hook's T=0 block read this to see what this instance is up to). **Not** the source of `working_memory` — that's graph-backed, parked for ingestion.
- `contextFunctions` — names from the global function registry; each template ships its default list.
- `dbPath` — relative to the `.brainifai/` folder the config lives in.
- `parent` — name of parent instance (typically `"global"` for first-level children).

## 4. Resolution

1. Walk up from cwd looking for `.brainifai/config.json`.
2. Read the folder config, return the list of instances in that folder.
3. MCP exposes tools from **all** instances, namespaced `<instance-name>.<tool>`.
4. Global fallback: if no project config found, use `~/.brainifai/config.json`.
5. ENV/flag overrides (e.g. `BRAINIFAI_INSTANCE_PATH`) can pin resolution to a specific folder.

Tool namespacing means multi-instance folders have zero ambiguity — `coding.get_project_context` vs `researcher.get_landscape` are distinct tools to Claude.

## 5. Interactive init flow

```
$ brainifai init

? Instance type: [general | coding | researcher | ehr | manager | project-manager]
? Workdir (folder this instance covers): [default cwd]
? Instance name: [default <foldername>-<type>]
? Description: [LLM-generated default from type + workdir, user can edit]
? Populate DB now? (runs: <type's populate script>) [only asked if type declares one]
```

### Post-init actions

1. Create (or extend) `<workdir>/.brainifai/config.json`
2. Create `<workdir>/.brainifai/<instance-name>/data/kuzu/`
3. Initialize Kuzu schema for the type
4. Register with global instance (entry in global's registry DB)
5. Ensure `.brainifai/` is in the project's `.gitignore`
6. Generate `.claude/skills/brainifai/SKILL.md` for the project
7. Optionally run the populate script

If config already exists at the folder, init **adds** the new instance to the list rather than overwriting.

## 6. Populate scripts

Each template may declare an optional DB-populate step:

```ts
{
  type: 'ehr',
  populate: {
    script: 'scripts/populate-synthea.ts',
    prompt: 'Populate graph from Synthea FHIR bundles?'
  }
}
```

Types with populate scripts (for now):

| Type              | What it does                              |
|-------------------|-------------------------------------------|
| `coding`          | Runs gitnexus analyze, seeds from git log |
| `researcher`      | Backfills from domain seed query          |
| `ehr`             | Loads Synthea FHIR bundles                |
| `project-manager` | Scans `~/Projects/` to enumerate projects |

Types without populate scripts: `general`, `manager`.

## 7. Global instance

- Created by a one-time `brainifai init` (no args, or with `--global`)
- Always contains exactly one `general` instance at creation time
- Additional instances can be added to global later (e.g. a `project-manager` at the global level)
- Acts as the root of the instance tree; all first-level project instances default to `parent: "global"`

## 8. Dropped / deferred

- **No migration** from the old single-instance-per-folder layout. Wipe and re-init manually.
- **No auto-bootstrap** of the global instance.
- **No config tunables** — knobs stay in code, not config.
- **No per-type system-prompt files.** T=0 context comes entirely from hook injection + MCP tool descriptions.
- **Description quality via LLM** — default comes from an LLM-generated suggestion during interactive init; user can accept/edit.

## 9. Open for later chapters

- Ingestion pipeline wiring per type
- Hooks & skills in the session lifecycle (what fires when, where T=0 injection is composed)
- How the global registry stays consistent when instances are added/removed
