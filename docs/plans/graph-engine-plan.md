# Graph Engine — Technical Plan

Translates `docs/design/graph-engine.md` into concrete implementation steps.

## 0. What's changing vs current code

| Aspect                   | Current                                      | Target                                                   |
|--------------------------|----------------------------------------------|----------------------------------------------------------|
| Directory                | `src/graphstore/kuzu/` per-type adapters     | `src/graph-engine/` reusable machinery + `src/instances/<type>/` per-type config |
| Write path               | Ad-hoc upsert-batch per source               | Unified `writeAtom(text|structured)` + async extraction worker |
| Entity resolution        | None (new memory = new Topic node)           | `resolve_entity()` with fuzzy + fit score + alias/merge  |
| Extraction               | Inline, blocking (researcher only)           | Async worker, ExtractionJob queue, idempotent            |
| Locking                  | None (GRAPHSTORE_ON_DEMAND dodge)            | Explicit file-based flock per instance                    |
| Aging/reconsolidation    | None                                         | Optional per type; read bumps last_accessed + access_count |
| Maintenance              | None                                         | Nightly/weekly/monthly passes, policy-driven             |
| Schema per type          | Hand-written adapter classes                 | Declarative `SchemaSpec` → Kuzu DDL generator            |

Existing per-type adapters (`researcher-adapter.ts`, `ehr-adapter.ts`, `project-manager-adapter.ts`) **stay put** during engine build. General is built on the engine first; legacy types migrate later.

## 1. Files to create / modify / delete

### New files (engine)

- `src/graph-engine/types.ts` — Atom, Entity, Occurrence, Association, Episode, SchemaSpec, ResolverConfig, MaintenancePolicy, LifecycleContext
- `src/graph-engine/schema-builder.ts` — generates Kuzu DDL from a SchemaSpec; also MIGRATIONS for ALTER TABLE
- `src/graph-engine/instance.ts` — `GraphEngineInstance` class: opens the DB, composes spec + DB handle + workers into one object callers interact with
- `src/graph-engine/write-path.ts` — `writeAtom`, `writeAtoms` (batch); handles text and structured modes
- `src/graph-engine/worker.ts` — extraction worker loop; claims ExtractionJob rows, runs LLM, writes entities
- `src/graph-engine/resolver.ts` — candidate retrieval, fit scoring, accept/alias/create decision
- `src/graph-engine/reconsolidation.ts` — `bumpReconsolidation(atoms, weight)`, `reinforceCoOccurrence(entities)`
- `src/graph-engine/queue.ts` — ExtractionJob CRUD helpers: enqueue, claimNext, complete, fail, retry
- `src/graph-engine/lock.ts` — file-based flock: `acquire`, `release`, `withLock` helper
- `src/graph-engine/llm.ts` — shared `ClaudeCliProvider` singleton (extracted from descriptions.ts + refinement.ts + researcher extract.ts)
- `src/graph-engine/fit-features.ts` — built-in feature extractors (name_similarity, recency, context_overlap, cwd_instance_match, type_match)
- `src/graph-engine/embedding.ts` — embedding generation + cache (OpenAI text-embedding-3-small via fetch initially; swappable)
- `src/graph-engine/maintenance/index.ts` — pass registry, runner, cadence scheduling
- `src/graph-engine/maintenance/tier-recompute.ts`
- `src/graph-engine/maintenance/alias-confirm.ts`
- `src/graph-engine/maintenance/dedupe.ts`
- `src/graph-engine/maintenance/summarize.ts`
- `src/graph-engine/maintenance/theme-detect.ts`
- `src/graph-engine/maintenance/aging-audit.ts`
- `src/graph-engine/index.ts` — public API: `createEngine(config)`, `startWorker`, `runMaintenance`, re-exports

### New files (per-type config for general)

- `src/instances/general/schema.ts` — SchemaSpec for general
- `src/instances/general/extract-prompt.ts` — LLM prompt for entity extraction
- `src/instances/general/resolver-config.ts` — weights + thresholds
- `src/instances/general/maintenance-config.ts` — which passes, when
- `src/instances/general/functions.ts` — `working_memory`, `associate`, `recall_episode`, `consolidate` built on engine primitives

### Modified files

- `src/instance/db.ts` — `initializeInstanceDb(dbPath, type)` delegates to `schema-builder.ts` when the type has a SchemaSpec; falls back to legacy adapter for old types
- `src/context/registry.ts` — lazy-import general's functions from `src/instances/general/functions.ts`
- `src/context/refinement.ts` — switch to shared `graph-engine/llm.ts` singleton (minor)
- `src/instance/descriptions.ts` — ditto
- `src/ingestion/researcher/extract.ts` — ditto

### Deleted / deprecated

- `src/orchestrator/` — entire directory can be removed per the design split (`graph-engine.md` §12.5). Do this as a final cleanup step to avoid cascading breakage mid-build.

### Not touched (coexist)

- `src/graphstore/kuzu/adapter.ts` (base Kuzu store)
- `src/graphstore/kuzu/researcher-adapter.ts`, `ehr-adapter.ts`, `project-manager-adapter.ts`
- Each type's existing ingestion (`src/ingestion/researcher-pipeline/`, `src/ingestion/project-manager/`)

These migrate to the engine later, one type at a time.

## 2. Phased task order

### Phase 1 — Types + schema builder (foundation)

1. **Define all engine types** in `src/graph-engine/types.ts`. Atom, Entity, Occurrence, Association, Episode, SchemaSpec, ResolverConfig, MaintenancePolicy, WriteAtomInput, LifecycleContext.
2. **Write `schema-builder.ts`**. Given a SchemaSpec, emit:
   - CREATE NODE TABLE statements (Atom, Entity, Episode, ExtractionJob, MaintenanceRun) with per-spec fields
   - CREATE REL TABLE statements (MENTIONS, IN_EPISODE, SUPERSEDES, SUMMARIZES, ALIAS_OF, IS_A, plus one per associationKind)
   - CREATE FTS INDEX statements (Atom.content if agingEnabled, Entity.name + aliases)
   - MIGRATIONS array for ALTER TABLE ADD COLUMN on schema evolution
3. **Write `instance.ts`**. `GraphEngineInstance` class wraps `{db, conn, spec, locks}`. Methods: `.initialize()`, `.close()`, and getters to access the raw `conn` for internal modules.
4. **Unit tests** for schema-builder: given general's SchemaSpec, verify the generated DDL is syntactically valid and contains every expected table/index.

### Phase 2 — Lock + queue (write-path dependencies)

5. **`lock.ts`** — file-based flock using `proper-lockfile` (already a widely-used library) or Node's native `fs.open` with `wx` flag + timeout. Expose `withLock(lockPath, fn)` helper.
6. **`queue.ts`** — ExtractionJob CRUD. Functions: `enqueue(atomId)`, `claimNext(workerId)` (atomic UPDATE ... WHERE status='queued'), `markDone(jobId)`, `markFailed(jobId, err)`, `requeue(jobId, backoff)`, `resetStaleInProgress(maxAgeMs)`.
7. **Tests** for queue: enqueue/claim roundtrip, concurrent-claim safety, stale-reset behavior.

### Phase 3 — Shared LLM provider

8. **`llm.ts`** — singleton `ClaudeCliProvider`; strip `ANTHROPIC_API_KEY`; default model `claude-haiku-4-5-20251001`; `complete(prompt, opts)` wrapper with timeout + retries; `embed(text)` wrapper (separate provider: OpenAI or the wrapper's embedding equivalent).
9. **Migrate** `descriptions.ts`, `refinement.ts`, `researcher/extract.ts` to use `graph-engine/llm.ts`. Remove the duplicated singletons.

### Phase 4 — Write path (text mode)

10. **`write-path.ts`**:
    - `writeAtom({content, kind, salience, context, supersedes?})` — Phase A sync write
    - Creates Atom node
    - Links to active Episode if `episodesEnabled`
    - Adds SUPERSEDES edges if provided (supports fuzzy cue → id resolution via engine's resolver)
    - Enqueues ExtractionJob
    - Returns `{id, superseded}`
    - All wrapped in `withLock`
11. **`writeAtoms([...])`** — batch version; one lock acquisition, one ExtractionJob per atom.
12. **Unit tests** — atom roundtrip, episode linkage, supersedes, lock contention.

### Phase 5 — Resolver

13. **`fit-features.ts`** — built-in features:
    - `name_similarity` (Jaccard on token bigrams, or Levenshtein ratio)
    - `recency` (days since `last_seen`, decayed)
    - `context_overlap` (count of shared CO_OCCURS between candidate and the memory's other entities)
    - `cwd_instance_match` (boolean)
    - `type_match` (boolean)
14. **`resolver.ts`**:
    - `resolveEntity(name, type, context, spec)` — candidate retrieval via FTS + vector index union
    - Compute `fit_score` per candidate using `spec.resolverConfig.weights`
    - Decide: accept (existing) / uncertain (new + ALIAS_OF suspected) / new
    - Writes all happen through the engine's `conn` with the caller's lock already held
15. **Tests** — known-duplicate scenarios, ambiguous-zone scenarios, new-entity creation. Needs a seeded test graph.

### Phase 6 — Extraction worker (text mode)

16. **`worker.ts`**:
    - `startWorker(engine)` launches a polling loop in the same process
    - Each tick: `claimNext`, fetch atom, call `spec.extractPrompt(content)` via `llm.complete`, parse JSON entities, acquire lock, for each: `resolveEntity` + MERGE MENTIONS, pairwise CO_OCCURS bump, embedding gen (if enabled), mark atom `extracted=true`, `markDone(job)`
    - Error paths: timeout, parse error, LLM down → backoff retry
    - Graceful shutdown on SIGTERM (finish current job, stop polling)
17. **Tests** — feed a memory with known content, run worker one tick, assert entities created and MENTIONS edges present. Idempotency test: re-run on same atom, assert no double MERGE.

### Phase 7 — Reconsolidation + retrieval helpers

18. **`reconsolidation.ts`**:
    - `bumpReconsolidation(atomIds, weight)` — `SET a.last_accessed=now, a.access_count += 1`; tier bump if enabled
    - `reinforceCoOccurrence(atomIds)` — for each retrieved atom, bump CO_OCCURS weights between its entity pairs
    - `decayWeights()` — scheduled utility the maintenance pass calls
19. **Engine read primitives** (live in `src/graph-engine/`, wrapped by per-type retrieval functions):
    - `fetchAtomsByOrder(orderBy, filter, limit)` — powers working_memory
    - `spreadActivation(seedEntities, hops, decay)` — powers associate
    - `fetchAtomsByEpisode(episodeIds, kindFilter)` — powers recall_episode
    - `searchEntities(query, k)` — FTS + vector union
20. **Tests** — scoring math, activation math (numeric assertions on small hand-built graphs).

### Phase 8 — Embedding support

21. **`embedding.ts`** — initially OpenAI `text-embedding-3-small` via direct fetch. Cache in-memory with LRU. Async; called from worker after entity extraction.
22. **Kuzu vector index** on `Atom.embedding` and `Entity.embedding`. Check Kuzu's current vector index support; fall back to client-side cosine if missing.
23. **Tests** — roundtrip embed/store/retrieve.

### Phase 9 — Maintenance passes

24. **Pass registry** in `maintenance/index.ts` — each pass is a module exporting `{ name, cadence, run(engine): Promise<stats> }`.
25. **Individual passes** (order of value):
    - `tier-recompute.ts` — O(N) UPDATE
    - `alias-confirm.ts` — LLM-confirm suspected ALIAS_OF, collapse on confirm
    - `dedupe.ts` — embedding cosine clustering → REINFORCED_BY edges
    - `summarize.ts` — cluster by shared entities + timeframe → LLM summary → semantic-summary atom + SUMMARIZES edges
    - `theme-detect.ts` — community detection on ASSOCIATED edges → theme atoms
    - `aging-audit.ts` — status='archived' for long-unrefrenced atoms
26. **Runner** — `runMaintenance(engine, passNames, {budget})` — respects per-pass timeout, logs MaintenanceRun node with stats.
27. **Scheduling**: OS cron for MVP. A tiny daemon (later) could also trigger on idle or on growth thresholds.

### Phase 10 — Structured mode writes

28. Extend `writeAtom` to accept `{preExtracted: [{name, type, occurrenceKind, prominence}]}`. Skip queue; run resolver inline; link MENTIONS + bump CO_OCCURS under the same lock acquisition.
29. Tests — structured roundtrip, mixed-mode atoms.

### Phase 11 — Cleanup + orchestrator removal

30. Delete `src/orchestrator/` and its references in `src/cli/commands/`, `src/ingestion/`.
31. Remove unused `getGraphStore` paths now that engine is the default write target.
32. Update CLAUDE.md with new layout + `src/graph-engine/` reference.

## 3. Dependencies between phases

```
Phase 1 (types + schema)
  └─► Phase 2 (lock + queue) ─┐
  └─► Phase 3 (LLM util) ─────┤
                              ├─► Phase 4 (write path, text)
                              │       │
                              │       ├─► Phase 5 (resolver) ─► Phase 6 (worker)
                              │       │                              │
                              │       └─► Phase 7 (reconsolidation + reads)
                              │                                      │
                              │       ┌─► Phase 8 (embeddings) ──────┤
                              │       │                              ▼
                              │       │                      Phase 9 (maintenance)
                              │       │                              │
                              │       └─► Phase 10 (structured mode) │
                              │                                      ▼
                              └──────────────────────────► Phase 11 (cleanup)
```

Parallel-safe: Phases 2 + 3 after Phase 1. Phases 8 and 10 after Phase 7. Phase 9 passes can ship incrementally (tier-recompute + alias-confirm first, others as time allows).

## 4. Test plan

### Unit (pure functions, mocked I/O)

- `schema-builder.test.ts` — generated DDL for known SchemaSpecs
- `fit-features.test.ts` — each feature function, boundary cases
- `resolver.test.ts` — decide thresholds, uncertain-zone behavior (in-memory Kuzu)
- `queue.test.ts` — claim safety, stale reset
- `lock.test.ts` — acquire/release, contention
- `reconsolidation.test.ts` — scoring math
- `write-path.test.ts` — atom + episode roundtrip, supersedes, lock held

### Integration (real Kuzu DB, temp dir)

- `engine-general.test.ts` — end-to-end: init engine with general spec → writeAtom → verify queue populated → run one worker tick → verify entities + MENTIONS + CO_OCCURS → fetchAtomsByOrder returns it
- `associate.test.ts` — seed a small graph, run spread activation, assert expected ranking
- `maintenance.test.ts` — run each pass on a seeded graph, assert invariants preserved

### Manual

- Boot a real general instance, write 20 memories, verify extraction catches up
- Run nightly maintenance manually, inspect MaintenanceRun stats
- Kill the worker mid-extraction, restart, verify stale job resets

## 5. Acceptance checklist

- [ ] `createEngine(spec, dbPath)` opens/initializes a Kuzu DB with all tables from the spec
- [ ] `writeAtom` returns in <20ms for text mode, <50ms for structured
- [ ] Worker processes queued atoms within ~3s of enqueue (LLM latency)
- [ ] Idempotency: re-processing an atom never double-increments CO_OCCURS
- [ ] Alias confirmation collapses matched entities, rewires edges, preserves mention_count
- [ ] `spreadActivation` on a 1K-atom graph returns in <100ms
- [ ] Maintenance nightly pass completes in <10min on a 10K-atom seed graph
- [ ] Graceful degradation: worker stops but writes still succeed
- [ ] No lock leaks after abrupt shutdown (lock file auto-expires or is cleared on start)

## 6. Out of scope for this plan

- Per-type functions for ehr/researcher/coding/project-manager/manager (each gets its own plan once engine is stable)
- Archive DB split (year-5+ concern)
- Vector index swap-out (plugin point, current plan uses Kuzu's native if available else client-side)
- Cross-process locking (single-host assumption; if Brainifai ever needs multi-host, revisit)
- Lifecycle hooks + skills wiring (separate plan)
- Migration of legacy adapters (`researcher-adapter.ts` etc.) to the engine — handled per-type later

## 7. Risks

- **Kuzu vector index API** may not be mature enough in current version. Mitigation: abstract behind `embedding.ts`; client-side cosine fallback.
- **Worker ↔ main-process lock contention** under heavy ingestion. Mitigation: short holds (single-digit ms main; ~100ms worker); instrument and alert.
- **LLM prompt drift** — extraction JSON shape varies across prompts. Mitigation: Zod schema validation on LLM output; regex + capitalized-word fallback when parse fails.
- **`@anagnole/claude-cli-wrapper` availability** for every LLM call. Mitigation: graceful degrade (skip extraction, atom stays `extracted=false`); retry on next worker tick.
- **Resolver false merges** — merging two different Annas destroys provenance. Mitigation: tentative ALIAS_OF edges, LLM-confirm before collapse, no inline destructive merges.
- **Maintenance pass runtime blowup** at scale. Mitigation: hard per-phase timeout; stats logged; rerun next cycle.
- **Test flakiness from real LLM calls** in integration tests. Mitigation: record/replay fixtures; avoid live LLM in CI unit tests; use real calls only in opt-in integration runs.

## 8. Estimated effort

| Phase | Tasks | Days |
|---|---|---|
| 1  Types + schema builder | 1–4 | 2 |
| 2  Lock + queue | 5–7 | 1 |
| 3  LLM util + migration | 8–9 | 0.5 |
| 4  Write path | 10–12 | 1.5 |
| 5  Resolver | 13–15 | 2 |
| 6  Worker | 16–17 | 1.5 |
| 7  Reconsolidation + reads | 18–20 | 1.5 |
| 8  Embeddings | 21–23 | 1 |
| 9  Maintenance passes | 24–27 | 3 |
| 10 Structured mode | 28–29 | 0.5 |
| 11 Cleanup + orchestrator removal | 30–32 | 0.5 |
| **Total** | | **~14.5 working days** |

MVP (Phases 1–7) is ~9.5 days and is enough to run general end-to-end with text-mode consolidates and basic retrieval. 8–10 add the polish; 11 is cosmetic.

## 9. Open decisions for implementation time

- **Embedding model** — OpenAI text-embedding-3-small first pass; evaluate BGE or a local model later
- **Vector index** — Kuzu native if available; else client-side cosine with LRU-cached embeddings
- **Lock library** — `proper-lockfile` vs native `fs.open({flag:'wx'})`. Library first; swap if problematic
- **Worker lifecycle** — in-process (same MCP process) vs separate daemon. Start in-process; daemon later if lock contention appears
- **Cron vs daemon for maintenance** — OS cron for MVP; in-process scheduler if we want idle-triggering
- **Schema migration strategy** — ALTER TABLE ADD COLUMN for additive changes; for breaking changes, version bump + migration runner (deferred)
