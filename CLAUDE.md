# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Brainifai is a **Personal Knowledge Graph (PKG)** system with two pipelines:
- **Ingestion**: Fetches data from tools (Slack, GitHub, ClickUp, Apple Calendar) → normalizes → upserts into Kuzu
- **Serving**: MCP server exposes curated graph query tools to Claude/LLM clients

**Stack**: TypeScript (ESM), Kuzu (embedded graph DB), MCP SDK (stdio transport), Slack Web API

## Data Location

Brainifai uses a **single global Kuzu database** at `~/.brainifai/data/kuzu`.
Override with `KUZU_DB_PATH` env var.

### What's global (all Claude sessions):
- MCP server (search, context, ingest) — via `~/.claude/settings.json`
- PreToolUse hook (KG context enrichment) — via `~/.claude/settings.json`
- `/remember` skill — via `~/.claude/skills/remember/`
- Kuzu database — single instance at `~/.brainifai/data/kuzu`

### What's per-project:
- `.mcp.json` — additional MCP servers (fal, clickup, figma)
- `.claude/settings.local.json` — permission allowlists
- Ingestion cursors — stored in the graph, not local files

## Commands

```bash
npm run ingest                    # Run ingestion (fetches new data, upserts to graph)
npm run mcp                       # Start MCP server (stdio transport, for Claude Desktop)
npm run schema                    # Create/update graph constraints and indexes
npm run test-connection           # Verify graph DB connectivity
npx tsc --noEmit                  # Type check
```

## Architecture

```
src/shared/       → GraphStore singleton, canonical types, schema, constants
src/graphstore/   → Kuzu + Neo4j backends, factory, on-demand wrapper
src/ingestion/    → Slack/GitHub/ClickUp/Calendar connectors, normalize, upsert, cursor
src/mcp/          → MCP server, 5 tools (search_entities, get_entity_summary,
                    get_recent_activity, get_context_packet, ingest_memory)
src/hooks/        → PreToolUse enricher (KG context injection)
src/api/          → Fastify API server for graph visualization
src/viz/          → React + Sigma.js graph visualization UI
src/scripts/      → One-off utilities (test-connection, seed-schema)
```

**Data model**: Entities (Person, Topic, Container) + Activities (Message) connected by typed relationships. All writes use MERGE for idempotency. Cursors stored as graph `:Cursor` nodes.

**MCP tools**: `get_context_packet` is the primary tool — given a query, it resolves anchors via fulltext search, gathers structural facts, collects time-windowed evidence, and returns a bounded context payload.

## Key Design Decisions

- All ingestion uses `MERGE` — safe to re-run, no duplicates
- Cursors in graph DB (not local files) — wipe DB = clean re-backfill
- MCP exposes curated tools only, no raw Cypher to the LLM
- Safety limits enforced: MAX_EVIDENCE=20, MAX_TOTAL_CHARS=8000, QUERY_TIMEOUT=10s
- Single global DB at `~/.brainifai/data/kuzu` — all sessions share the same knowledge
- OnDemand graph store for MCP/hooks — avoids write lock contention with ingestion

## Environment Variables (see .env.example)

`KUZU_DB_PATH`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_IDS`, `GITHUB_TOKEN`, `GITHUB_REPOS`, `CLICKUP_TOKEN`, `CLICKUP_LIST_IDS`, `BACKFILL_DAYS`, `TOPIC_ALLOWLIST`

## Workflow Orchestration
### 1. Plan Node Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity
#### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems,
throw more compute at it via subagents
- One tack per subagent for focused execution
### 3. Self-Improvement Loop
- After ANY correction from the user: update "tasks/lessons.md"
with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project
### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness
### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it
### 6. Autonomous Bug Fizing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests - then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how
## Task Management
1. **Plan First**: Write plan to 'tasks/todo.md with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to "tasks/todo.md"
6. **Capture Lessons**: Update 'tasks/lessons.md' after corrections
## Core Principles
- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimat Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Brainifai** (1030 symbols, 2256 relationships, 75 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/Brainifai/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/Brainifai/context` | Codebase overview, check index freshness |
| `gitnexus://repo/Brainifai/clusters` | All functional areas |
| `gitnexus://repo/Brainifai/processes` | All execution flows |
| `gitnexus://repo/Brainifai/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
