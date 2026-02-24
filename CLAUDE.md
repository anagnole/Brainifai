# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Brainifai is a **Personal Knowledge Graph (PKG)** system with two pipelines:
- **Ingestion**: Fetches data from tools (Slack MVP) → normalizes → upserts into Neo4j
- **Serving**: MCP server exposes curated graph query tools to Claude/LLM clients

**Stack**: TypeScript (ESM), Neo4j 5 (Docker), MCP SDK (stdio transport), Slack Web API

## Commands

```bash
docker compose up -d              # Start Neo4j (bolt://localhost:7687, browser at :7474)
npm run test-connection           # Verify Neo4j connectivity
npm run schema                    # Create/update Neo4j constraints and indexes
npm run ingest                    # Run Slack ingestion (fetches new messages, upserts to graph)
npm run mcp                       # Start MCP server (stdio transport, for Claude Desktop)
npx tsc --noEmit                  # Type check
```

## Architecture

```
src/shared/       → Neo4j driver singleton, canonical types, schema, constants
src/ingestion/    → Slack connector, normalize, topic extraction, MERGE-based upsert, cursor
src/mcp/          → MCP server, 4 tools (search_entities, get_entity_summary,
                    get_recent_activity, get_context_packet), backing Cypher queries, safety
src/scripts/      → One-off utilities (test-connection, seed-schema)
```

**Data model**: Entities (Person, Topic, Container) + Activities (Message) connected by typed relationships. All writes use MERGE for idempotency. Cursors stored as Neo4j `:Cursor` nodes.

**MCP tools**: `get_context_packet` is the primary tool — given a query, it resolves anchors via fulltext search, gathers structural facts, collects time-windowed evidence, and returns a bounded context payload.

## Key Design Decisions

- All ingestion uses `MERGE` — safe to re-run, no duplicates
- Cursors in Neo4j (not local files) — wipe DB = clean re-backfill
- MCP exposes curated tools only, no raw Cypher to the LLM
- Safety limits enforced: MAX_EVIDENCE=20, MAX_TOTAL_CHARS=8000, QUERY_TIMEOUT=10s
- Slack ts stored as string on Cursor nodes (preserves precision); ISO 8601 on Activity nodes

## Environment Variables (see .env.example)

`NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_IDS`, `BACKFILL_DAYS`, `TOPIC_ALLOWLIST`

## MCP Client Configuration (Claude Desktop)

```json
{
  "mcpServers": {
    "brainifai": {
      "command": "npx",
      "args": ["tsx", "src/mcp/index.ts"],
      "cwd": "/path/to/Brainifai",
      "env": { "NEO4J_URI": "bolt://localhost:7687", "NEO4J_USER": "neo4j", "NEO4J_PASSWORD": "..." }
    }
  }
}
```

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
