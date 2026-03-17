# Audit 005: Context Building Pipeline

**Date**: 2026-03-12
**Scope**: `get_context_packet` tool, fulltext search, expand/facts, timeline/evidence, graph slice
**Files reviewed**:
- `src/mcp/queries/context-packet.ts`
- `src/mcp/tools/get-context-packet.ts`
- `src/mcp/tools/search-entities.ts`
- `src/mcp/queries/search.ts`
- `src/mcp/queries/activity.ts`
- `src/mcp/safety.ts`
- `src/graphstore/kuzu/adapter.ts` (search, expand, timelineMulti, neighborhood)
- `src/graphstore/kuzu/schema.ts` (FTS index definitions)
- `src/graphstore/types.ts`
- `src/shared/constants.ts`
- `src/graphstore/defaults.ts`

---

## Summary

`get_context_packet` is a four-stage pipeline: (1) anchor resolution via FTS, (2) structural fact collection via `expand()`, (3) time-windowed evidence via `timelineMulti()`, and (4) an optional neighborhood graph slice. The architecture is clean and the stages compose well. The main risks are in search quality (single-field FTS indexes, no fuzzy/prefix matching), silent failure masking (bare `catch {}` blocks throughout), and the graph slice being anchored only on the first seed regardless of query intent.

---

## Strengths

1. **Well-layered architecture.** The pipeline has clear separation: tool interface (Zod validation) -> query orchestrator (`buildContextPacket`) -> GraphStore adapter. Each layer has a single responsibility.

2. **Sensible safety guardrails.** `truncateEvidence` enforces both item count (MAX_EVIDENCE_ITEMS=20) and character budget (MAX_TOTAL_CHARS=16000). Individual snippets are capped at 2000 chars. Query timeout exists at 10s. These prevent runaway context injection.

3. **Idempotent and stateless.** The context packet is computed fresh per call with no caching side-effects. Combined with the OnDemand adapter pattern, this avoids write-lock contention.

4. **Evidence is well-structured.** Each evidence item carries timestamp, source, kind, snippet, URL, actor, and channel -- enough metadata for an LLM to assess relevance and recency without needing raw graph access.

5. **Deduplication in timelineMulti.** Uses a `seenIds` set keyed on `source_id` to prevent duplicate activities when multiple anchors connect to the same message.

6. **Parameter validation.** Zod schema on the tool interface enforces `window_days` in [1, 365] and `limit` in [1, 50], preventing abuse.

---

## Issues

### Critical

**C1: FTS indexes are single-field and lack fuzzy/prefix support.**
Person FTS indexes only `display_name`, Topic only `name`, Container only `name`. A search for "Alex" will not match a person whose `person_key` is "alex.smith" but whose `display_name` is "Alexander Smith" -- there is no prefix or fuzzy matching. Kuzu FTS uses BM25 which requires exact token matches. This means the anchor resolution step -- the foundation of the entire pipeline -- can miss relevant entities on partial or informal name queries.

**C2: Silent error swallowing masks data quality issues.**
Throughout the adapter (`search`, `expand`, `timelineMulti`, `neighborhood`), every query is wrapped in bare `catch {}` blocks that silently discard errors. If an FTS index is corrupt, a schema migration failed, or a Cypher query has a bug, the system returns empty results with no indication of failure. This makes debugging production issues extremely difficult. The `buildContextPacket` orchestrator itself has no error handling at all -- if `getGraphStore()` fails, the error propagates unhandled.

### Important

**I1: Graph slice uses only the first anchor, ignoring query intent.**
`neighborhood()` is called with `seeds[0]` only (line 125 of context-packet.ts). If the query matches multiple entities, the graph slice only reflects the highest-scoring one. For a query like "Alex and the deploy pipeline", the slice would show Alex's neighborhood but nothing about deploy-related containers or topics. This reduces the utility of the graph slice for multi-entity queries.

**I2: FTS searches tables sequentially, not in parallel.**
The `search()` method iterates `filteredTables` with a serial `for...of` loop, issuing one FTS query per table type. With 4 tables (Person, Topic, Container, Activity), this is 4 sequential round-trips. While Kuzu is embedded (so no network latency), this is still suboptimal and will scale poorly if more entity types are added.

**I3: `expand()` issues N+1 queries per seed.**
For each seed, `expand()` runs: 1 count query + 1 name query + 3 related-entity queries (one per target label) = 5 queries per seed. With 5 anchors, that's 25 queries. Combined with the 4 search queries and the timeline query, a single `get_context_packet` call can issue 30+ queries. There is no batching or query consolidation.

**I4: Fact sentences are formulaic and low-information.**
The `facts` array produces strings like `"Alice (Person): 47 activities in the last 30 days. Connected to: #general (Container), deploy (Topic), Bob (Person)"`. The activity count and top-3 connections are useful but shallow. There is no distinction between activity types (messages vs. commits vs. tasks), no temporal trend (increasing/decreasing), and no relationship characterization (collaborator vs. mentioned-in-passing).

**I5: No relevance ranking of evidence items.**
`timelineMulti` returns activities ordered by `timestamp DESC` only. There is no relevance scoring relative to the original query. The 20 most recent activities connected to any anchor are returned, even if they are tangentially related. A message in a channel where the anchor person once posted counts equally to a message directly from/about them.

**I6: `search()` query escaping is insufficient.**
The FTS query is interpolated into the Cypher string with only single-quote escaping (`replace(/'/g, "''")`). This does not protect against Kuzu FTS query syntax injection. Special characters like `*`, `?`, `+`, `-`, `(`, `)` in the search query could alter FTS behavior or cause errors. The query is not parameterized because `QUERY_FTS_INDEX` requires a string literal.

### Nice-to-Have

**N1: No caching of context packets.**
Identical queries within seconds produce identical results but re-execute 30+ graph queries each time. A short TTL cache (30-60s) keyed on `(query, windowDays, limit)` would reduce load during LLM retry loops or rapid tool calls.

**N2: `minScore` threshold of 0.3 is arbitrary and untested.**
The default minimum FTS score of 0.3 filters out low-relevance matches, but BM25 scores are not normalized -- they depend on corpus size, term frequency, and document length. A score of 0.3 could be highly relevant in a small corpus or irrelevant in a large one. There is no documentation or testing of this threshold.

**N3: Activity FTS index includes `kind` field alongside `snippet`.**
The Activity FTS index is built on `['snippet', 'kind']` (schema.ts line 125). Searching for "message" will boost activities with `kind: "message"` in scoring, which conflates content relevance with type filtering. The `kind` field should be a structured filter, not a text search field.

**N4: `window_days` default mismatch.**
`get_context_packet` defaults to `DEFAULT_WINDOW_DAYS` (30 days from constants.ts), but `GraphStore` defaults use `GS_DEFAULT_WINDOW_DAYS` (180 days from defaults.ts). The timeline query in `buildContextPacket` explicitly passes the window, so this doesn't cause a bug, but the dual defaults are confusing.

**N5: Graph slice neighborhood traversal only looks at incoming edges.**
The `neighborhood()` method only matches `(root)<-[r:REL]-(neighbor)` (incoming direction). This means outgoing relationships from the root are invisible in the graph slice. For example, if a Person node has outgoing MENTIONS edges, those would not appear.

---

## Recommendations

1. **Improve search resilience (C1).** Add `person_key` to the Person FTS index. Consider implementing a fallback prefix/substring search when FTS returns zero results (e.g., `WHERE n.display_name CONTAINS $query`). Evaluate whether Kuzu supports stemming or configurable tokenizers for the FTS extension.

2. **Replace bare catch blocks with logged warnings (C2).** At minimum, log a warning with the query and error message in every catch block. Consider introducing a `safeQuery()` wrapper that logs failures and returns empty results, so the pattern is consistent and auditable.

3. **Expand graph slice to cover all anchors (I1).** Run `neighborhood()` for each anchor seed (up to the 5 limit) and merge the resulting subgraphs, deduplicating by node ID. This would make the graph slice representative of the full query.

4. **Add relevance-aware evidence ranking (I5).** After collecting timeline items, score each against the anchor it came from (direct relationship = higher score, 2-hop = lower). Sort by a composite of recency and relevance rather than recency alone.

5. **Enrich fact sentences (I4).** Break down activity counts by kind (e.g., "12 messages, 5 commits, 3 tasks"). Add temporal context ("most recent: 2 hours ago" vs. "most recent: 3 weeks ago"). Characterize relationships ("frequent collaborator" vs. "mentioned once").

6. **Parameterize or sanitize FTS queries (I6).** If Kuzu's `QUERY_FTS_INDEX` does not support parameterized queries, strip or escape FTS-special characters from the input before interpolation.

7. **Add lightweight result caching (N1).** A Map with TTL eviction keyed on query+params would prevent redundant work during rapid successive calls.
