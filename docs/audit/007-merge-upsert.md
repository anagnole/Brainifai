# Audit 007 — MERGE / Upsert Idempotency

**Date**: 2026-03-12
**Scope**: `src/ingestion/upsert.ts`, `src/graphstore/kuzu/adapter.ts`, `src/graphstore/types.ts`, all normalizers
**Status**: Research-only (no code changes)

---

## Summary

The ingestion pipeline normalizes data from five sources (Slack, GitHub, ClickUp, Apple Calendar, Claude Code) into a canonical `NormalizedMessage` shape, then upserts nodes and edges via `upsertBatch()`. The Kuzu adapter generates per-row `MERGE` statements with `ON CREATE SET` / `ON MATCH SET` clauses. The system is generally well-designed for idempotent re-runs, but has several issues around cross-source person resolution, schema/merge-key mismatches, partial failure windows, and timestamp overwriting.

---

## Strengths

1. **Consistent MERGE pattern**: All writes use `MERGE` with parameterized queries — safe against duplicates, safe to re-run.

2. **In-memory dedup before write**: `upsertBatch()` uses `Map`s keyed by merge key, so duplicate persons/containers/activities within a single batch are collapsed before any DB call.

3. **Source-scoped keys are collision-free within a source**: Keys like `slack:U12345`, `github:octocat`, `clickup:123:task:456` are well-namespaced.

4. **Edge MERGE uses endpoint match keys**: Edges are merged by matching both endpoint nodes, so `MERGE (a)-[r:TYPE]->(b)` is idempotent for a given node pair.

5. **Ordered upsert**: Nodes are upserted before edges, so edge endpoints always exist. Edge types that reference parent activities (REPLIES_TO) are handled after the Activity nodes are created.

6. **Lazy FTS invalidation**: `upsertNodes()` sets `ftsBuilt = false`, and the next `search()` call triggers a rebuild. This avoids unnecessary rebuilds during batch ingestion.

---

## Issues

### CRITICAL

#### C1. Container primary key is `container_id` alone, but merge uses `['source', 'container_id']`

**Schema** (`schema.ts` line 66-73):
```
CREATE NODE TABLE IF NOT EXISTS Container (
  ...
  PRIMARY KEY (container_id)
)
```

**Upsert** (`upsert.ts` line 166):
```ts
await store.upsertNodes('Container', [...containersMap.values()], ['source', 'container_id']);
```

Kuzu's `MERGE` on `{source: ..., container_id: ...}` will attempt to match both fields, but the PRIMARY KEY is only `container_id`. If two sources happen to share a `container_id` value (unlikely but possible with short numeric IDs from ClickUp), the MERGE would match the wrong node. More importantly, the merge clause includes `source` as a match key, but Kuzu's primary key index only covers `container_id` — the `source` constraint is unenforced at the DB level, meaning the MERGE may succeed creating a duplicate conceptual container with the same `container_id` but different `source` only to find it merges to the existing row anyway since PK is only `container_id`.

**Same issue applies to `SourceAccount`**: PK is `account_id` alone, but merge uses `['source', 'account_id']`.

#### C2. REPLIES_TO edge `to` key is missing `source` — may match wrong parent

**Upsert** (`upsert.ts` lines 138-146):
```ts
repliesToEdges.push({
  ...
  to: { source_id: msg.activity.parent_source_id },  // only source_id
});
```

The Activity table has PK `source_id`, and the `parent_source_id` values are already source-prefixed (e.g., `slack:C123:1234.5678`), so this works in practice. However, the `from` side includes `{ source, source_id }` while the `to` side only has `{ source_id }`. This asymmetry is not a bug today (since `source_id` is globally unique by construction) but is fragile.

### IMPORTANT

#### I1. No cross-source person resolution

Each source creates an independent `:Person` node with a source-prefixed key:
- Slack: `slack:U12345`
- GitHub: `github:octocat`
- ClickUp: `clickup:789`
- Apple Calendar: `apple-calendar:user@example.com`
- Claude Code: `local:username`

The same real person has separate `:Person` nodes per source. The `SourceAccount` + `IDENTIFIES` edge pattern is in place (account -> person), suggesting the intent is to link accounts to a unified person, but today `linked_person_key` always equals the source-prefixed key. There is no cross-source linking logic — a human known as `slack:U123` and `github:octocat` will appear as two unrelated people.

**Impact**: Queries like "what has Alice been working on?" will only return results from a single source, fragmenting the knowledge graph's core value proposition.

#### I2. ON MATCH SET overwrites `created_at` and `display_name` on every re-run

**Adapter** (`adapter.ts` lines 521-526): `ON MATCH SET` updates all non-merge-key properties, including `created_at`:
```ts
const onMatchSet = setKeys.length > 0
  ? 'ON MATCH SET ' + setKeys.map((k) => `n.${k} = $${k}`).join(', ')
  : '';
```

The `created_at` field is set to `new Date().toISOString()` in `upsert.ts` line 15, so every re-run overwrites `created_at` with the current time. This defeats the purpose of tracking when an entity was first seen.

Similarly, `display_name` for Slack persons is initially set to the raw user ID (`msg.user`), and if a later enrichment updates it to a real name, a re-ingestion run would overwrite it back to the user ID.

#### I3. No transaction boundary around node+edge upserts — partial failure leaves orphan state

`upsertBatch()` issues 12 sequential `await` calls (5 node upserts + 7 edge upserts). Each `upsertNodes`/`upsertEdges` call internally loops through individual rows with separate `exec()` calls. There is no transaction wrapping the full batch.

If the process crashes midway (e.g., after upserting Person and Container nodes but before FROM edges), the graph is left in a partially-connected state. The MERGE pattern means a re-run will fix this, but any queries between the crash and the re-run will see orphaned nodes.

**Kuzu note**: Kuzu auto-commits each statement. There is no `BEGIN TRANSACTION` usage in the adapter.

#### I4. Edge properties only use ON CREATE SET — updates are silently dropped

**Adapter** (`adapter.ts` lines 557-561):
```ts
propSet = 'ON CREATE SET ' + propKeys.map((k) => `r.${k} = $prop_${k}`).join(', ');
```

Edge properties (like `timestamp`, `first_seen`) are only set when the edge is first created. If an edge already exists and the re-run has updated property values, those updates are silently discarded. For most edges this is fine (timestamp is immutable), but for `IDENTIFIES.first_seen` it means the value will always be the timestamp of the first ingestion run, not the actual first-seen time of the account-person link.

### NICE-TO-HAVE

#### N1. FTS rebuild is not atomic — search may fail during rebuild window

`rebuildFtsIndexes()` drops all 4 FTS indexes, then recreates them sequentially. Between the drop and create, any concurrent `search()` call will encounter missing indexes. The `try/catch` in `search()` silently swallows errors, returning empty results during this window.

Since the MCP server uses a read-only `OnDemandAdapter` that sets `ftsBuilt = true` at init and never writes, this only affects the ingestion process's own store instance. Low practical impact but worth noting.

#### N2. Row-at-a-time MERGE is slow for large batches

Both `upsertNodes()` and `upsertEdges()` loop through each record individually, issuing a separate `prepare + execute` per row. With `UPSERT_BATCH_SIZE = 100` and 5 node types + 7 edge types, a single batch can issue up to 1200 individual DB statements. Kuzu supports `UNWIND` for batch operations which could significantly improve throughput.

#### N3. Activity table PK is `source_id` alone, but MERGE uses `['source', 'source_id']`

Same pattern as C1 but lower risk since `source_id` values are always source-prefixed (e.g., `slack:C123:1234.5678`), making collisions impossible by construction. The extra `source` field in the merge key is redundant but harmless — it just means the MERGE checks a non-indexed column unnecessarily.

---

## Recommendations

1. **Align schema PKs with merge keys** (fixes C1): Either make `Container` PK a composite `(source, container_id)` (if Kuzu supports it) or change the merge key to `['container_id']` only. Same for `SourceAccount`. If Kuzu does not support composite PKs, consider creating a synthetic PK like `source + ':' + container_id`.

2. **Implement cross-source person linking** (fixes I1): Add a person-resolution step that maps known identities (e.g., via a config file or `:SameAs` edges). The `SourceAccount.linked_person_key` field already exists for this purpose — use it to point multiple accounts at a single canonical `Person` node.

3. **Protect `created_at` from overwrites** (fixes I2): Exclude `created_at` from the `ON MATCH SET` clause, or use a conditional like `ON MATCH SET n.updated_at = $updated_at` (keeping `created_at` out). Also consider excluding `display_name` from ON MATCH SET when the incoming value is a raw ID.

4. **Add ON MATCH SET to edge upserts** (fixes I4): Change edge property handling to include both `ON CREATE SET` and `ON MATCH SET` for properties that should be kept current, or explicitly choose which properties are create-only vs. updateable.

5. **Wrap batch upsert in a transaction** (fixes I3): If Kuzu supports explicit transactions, wrap the entire `upsertBatch()` in `BEGIN`/`COMMIT` to ensure atomicity.

6. **Consider batch UNWIND for performance** (addresses N2): Replace per-row MERGE with `UNWIND $batch AS row MERGE (n:Label {key: row.key}) ...` to reduce round-trips.
