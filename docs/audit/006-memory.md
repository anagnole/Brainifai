# Audit 006 — `ingest_memory` System

**Date**: 2026-03-12
**Scope**: `src/mcp/tools/ingest-memory.ts`, `src/ingestion/upsert.ts`, `src/ingestion/normalize.ts`, retrieval via `search_entities` / `get_context_packet`

---

## Summary

The `ingest_memory` MCP tool lets Claude save knowledge snippets (decisions, insights, bug fixes, preferences, session summaries) into the Kuzu graph as `:Activity` nodes linked to `:Topic`, `:Person`, and `:Container` nodes. It reuses the `NormalizedMessage` shape and `upsertBatch` pipeline designed for Slack/GitHub ingestion. The approach works but has a dedup gap and some retrieval friction.

---

## Strengths

1. **Full graph integration**: Memories are first-class `:Activity` nodes with `:MENTIONS` edges to `:Topic` nodes, `:FROM` edges to `:Person`, and `:IN` edges to `:Container`. This means they participate in `expand()`, `timelineMulti()`, and `neighborhood()` queries used by `get_context_packet`.

2. **Topic linking works correctly**: User-provided topics are lowercased and upserted as `:Topic` nodes via the same `upsertBatch` path. Each gets a `:MENTIONS` edge from the Activity. These topics are FTS-indexed (`topic_fts` on `name`), so searching for a topic name will find the Topic node, and `get_context_packet` will gather evidence (including memories) connected to it.

3. **Activity FTS index**: Activities have their own FTS index on `snippet` and `kind`. This means memory snippets are directly searchable via `search_entities` (type `Activity`), and will surface in `get_context_packet` anchor resolution.

4. **Clean reuse of upsert pipeline**: Using `upsertBatch` avoids duplicating MERGE logic. The `NormalizedMessage` shape maps without error — all required fields are populated.

5. **Short-lived write store**: Opens a dedicated `KuzuGraphStore` for the write and closes it in a `finally` block, avoiding lock contention with the read-only MCP server connection.

---

## Issues

### Critical

**C1 — Dedup gap: timestamp in `source_id` prevents idempotent saves**

The `source_id` is constructed as:
```
claude-code:memory:${timestamp}:${contentHash}
```

The timestamp is ISO 8601 with millisecond precision, replaced colons/dots with dashes. Since `upsertBatch` uses `MERGE` on `(source, source_id)`, calling `ingest_memory` with identical snippet text at two different times creates two separate `:Activity` nodes. The content hash alone would deduplicate, but the timestamp prefix defeats it.

This matters because the `/remember` skill or repeated tool calls can easily produce duplicate memories. Over time, this inflates the graph with redundant nodes that all surface as separate evidence items.

**Fix**: Remove the timestamp from `source_id`. Use `claude-code:memory:${contentHash}` (or `claude-code:memory:${kind}:${contentHash}`) as the merge key. If the same content is saved again, MERGE will update `timestamp`/`updated_at` instead of creating a new node.

---

### Important

**I1 — FTS indexes not rebuilt after `ingest_memory` writes**

`ingest_memory` opens its own `KuzuGraphStore`, calls `upsertBatch`, and closes it. After `upsertNodes`, the adapter sets `this.ftsBuilt = false` (line 537). However, because the store is immediately closed, FTS is never rebuilt on that connection. The MCP server's read-only `OnDemandAdapter` has its own `ftsBuilt` flag — it will eventually rebuild on the next `search()` call, but only if it detects stale indexes. This means newly ingested memories may not be immediately searchable.

This is a known architectural constraint of Kuzu's immutable FTS, but it's worth noting that there is no explicit FTS rebuild after a memory write.

**I2 — `NormalizedMessage` is a slightly forced fit for memories**

The `NormalizedMessage` type was designed for Slack messages and carries fields that are meaningless for memories:
- `thread_ts`, `parent_source_id`, `url` — always null/undefined for memories
- `person` / `account` — the user is both author and audience; the Slack-style `source_id: userName` on the person is a divergence from the `slack:U12345` pattern used elsewhere
- `container.kind: 'project'` — a synthetic container type not used by any other connector

This works today but creates semantic ambiguity: a `:Container` with `kind: 'project'` and `container_id: 'memory:general'` is structurally identical to a Slack channel container but means something entirely different. Queries filtering by `kind` will need to handle both.

**I3 — `memory:{project}` container may be hard to retrieve by name**

The container is created with:
- `container_id: 'memory:${projectName}'`
- `name: projectName` (e.g., `"Brainifai"` or `"general"`)
- `source: 'claude-code'`

The `get_recent_activity` tool strips source prefixes from `containerId` before querying (line 32-34 in `activity.ts`). So passing `containerId: "claude-code:memory:Brainifai"` would strip to `"memory:Brainifai"` which matches. But the user would need to know this composite ID format.

Searching by `containerName` works better — it uses the plain project name. However, if the user has a Slack channel with the same name as a project, results will be mixed.

---

### Nice-to-Have

**N1 — No validation that `kind` values are stored consistently**

The `MEMORY_KINDS` enum (`decision`, `insight`, `bug_fix`, `preference`, `session_summary`) is only validated at the MCP tool input layer. Once stored as an `:Activity` node, `kind` is a plain string. The `get_recent_activity` tool accepts a `kinds` filter, but there's no documentation of valid kind values for memory activities vs. other sources (Slack uses `message`, GitHub uses `pr`, `issue`, etc.).

**N2 — Content hash truncated to 12 hex characters**

The SHA-256 hash is sliced to 12 chars (48 bits of entropy). With a birthday-bound collision threshold around 2^24 (~16M) items, this is fine for practical use but worth documenting as a design choice.

**N3 — `MAX_SNIPPET_CHARS` truncation applied twice**

The snippet is truncated in `ingest-memory.ts` (line 36-38) before constructing `NormalizedMessage`. The Slack normalizer does the same at its layer. This is consistent but means the truncation limit is silently enforced — the user gets no feedback that their 5000-char snippet was truncated.

---

## Recommendations

1. **Fix dedup (C1)**: Change `source_id` to `claude-code:memory:${contentHash}` (dropping the timestamp). Use `valid_from` / `updated_at` to track when the memory was last saved. This makes MERGE genuinely idempotent for identical content.

2. **Consider a `Memory` node label (I2)**: Instead of overloading `:Activity`, introduce a `:Memory` node type with memory-specific fields (`kind` from the memory enum, `project`). This avoids semantic ambiguity and allows memory-specific queries. Alternatively, add a `memory: true` boolean property to Activity nodes for filtering.

3. **Trigger FTS rebuild after write (I1)**: Call `rebuildFtsIndexes()` on the write store before closing it, or implement a signaling mechanism (e.g., a file-based flag) so the read-only MCP store knows to rebuild on next search.

4. **Add a `list_memories` tool**: A dedicated retrieval tool that queries by project, kind, and topic would be more ergonomic than using `get_recent_activity` with the right container ID format. This would also provide a natural place to filter by `MEMORY_KINDS`.

5. **Warn on truncation (N3)**: If the snippet exceeds `MAX_SNIPPET_CHARS`, include a note in the response text that the content was truncated.
