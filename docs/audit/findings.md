# Phase 1 Audit Findings

## What Works Well

- **MERGE-based idempotency**: All ingestion uses MERGE — safe to re-run without duplicates (except memory, see below)
- **Fault isolation**: `Promise.allSettled` in the ingestion orchestrator prevents one connector from killing the pipeline
- **Context packet architecture**: Clean layered pipeline (anchor → facts → evidence → graph slice) with good safety guardrails (character budgets, item limits, timeouts)
- **Cursor-in-graph design**: Cursors stored as `:Cursor` nodes — wipe DB = clean re-backfill, no stale local files
- **OnDemand adapter**: Read-only MCP/hook connections avoid write-lock contention with ingestion

## What Needs Improvement

### Critical

| # | Area | Issue |
|---|------|-------|
| C1 | Memory | `source_id` includes timestamp — same content at different times creates duplicate `:Activity` nodes |
| C2 | Context | FTS indexes are single-field with no fuzzy/prefix support; silent `catch {}` blocks swallow all errors |
| C3 | Upsert | Container/SourceAccount PK schema doesn't match composite merge keys |
| C4 | Upsert | REPLIES_TO edge `to` key omits `source`, relying on convention not constraint |

### Important

| # | Area | Issue |
|---|------|-------|
| I1 | Ingestion | Apple Calendar cursor advances unconditionally even if upserts fail |
| I2 | Ingestion | Slack thread replies never fetched (only top-level messages) |
| I3 | Ingestion | GitHub reviews and ClickUp comments re-fetched with no timestamp filter (N+1) |
| I4 | Upsert | No cross-source person resolution — each source creates separate `:Person` nodes |
| I5 | Upsert | `ON MATCH SET` overwrites `created_at` and `display_name` on every re-run |
| I6 | Upsert | No transaction boundary around 12 sequential upsert calls — partial failures leave inconsistent state |
| I7 | Context | Graph slice only uses first anchor seed; N+1 query pattern in `expand()` |
| I8 | Context | Evidence ranked by recency only, not relevance to the query |
| I9 | Memory | FTS indexes not rebuilt after `ingest_memory` writes (lazy rebuild on next search) |
| I10 | Memory | `NormalizedMessage` is a forced fit — fields like `thread_ts`, `url` always empty |

### Nice-to-have

| # | Area | Issue |
|---|------|-------|
| N1 | Ingestion | Display names use Slack user IDs and ClickUp doc creator IDs instead of resolved names |
| N2 | Ingestion | Claude Code LLM topics bypass the topic allowlist |
| N3 | Context | No result caching; `minScore=0.3` is arbitrary for BM25 |
| N4 | Context | `neighborhood()` only traverses incoming edges |
| N5 | Upsert | Row-at-a-time MERGE performance; FTS rebuild non-atomic |

## Carry Forward

- **Kuzu embedded graph**: Works well, good performance for the scale
- **MCP tool interface**: Clean tool definitions with Zod validation
- **Normalized message pipeline**: Good abstraction for multi-source ingestion
- **Context packet algorithm**: Sound architecture, needs search quality improvements
- **GraphStore interface**: Well-designed, backend-agnostic (now Kuzu-only but extensible)

## Rebuild

- **FTS search**: Current single-field indexes miss too many queries; needs multi-field, prefix, and fuzzy support
- **Person resolution**: Cross-source identity linking is essential for useful graph queries
- **Memory dedup**: `source_id` hashing must exclude timestamp to prevent duplicates
- **Error observability**: Silent catch blocks throughout the adapter need logging

## Extraction Summary

| Component | Action | New Location |
|-----------|--------|-------------|
| mcp-clickup | Extracted | `~/Projects/mcps/mcp-clickup/` |
| mcp-fal | Extracted | `~/Projects/mcps/mcp-fal/` |
| figma-writer-mcp | Moved | `~/Projects/mcps/mcp-figma-writer/` |
| Neo4j adapter | Removed | `src/graphstore/neo4j/`, `src/shared/neo4j.ts`, `src/shared/schema.ts` |
| ui/ (Next.js) | Removed | Superseded by `src/viz/` (React+Sigma.js) |

## Detailed Audits

- [004 — Ingestion Pipeline](./004-ingestion.md)
- [005 — Context Building](./005-context-building.md)
- [006 — Memory System](./006-memory.md)
- [007 — MERGE/Upsert Process](./007-merge-upsert.md)
