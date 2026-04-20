# Graph Engine — Type-Agnostic Machinery

Status: reusable machinery shared across all Brainifai instance types. Each type provides a schema spec + prompts + config; the engine handles writes, reads, maintenance, and scaling.

Companion: `general-instance-graph.md` (concrete config for the brain-like general instance). Future docs will add `ehr-instance-graph.md`, `researcher-instance-graph.md`, etc.

## 1. What the engine is

A single set of mechanics — write path, resolver, extraction worker, reconsolidation, aging, maintenance passes, single-writer lock — that operates over any instance type's graph. Every type plugs in a declarative spec saying "here are my node kinds, edge kinds, extract prompt, resolver weights, and maintenance policies." The engine does the rest.

**Goal:** when we build EHR or researcher types, we don't re-implement the write path or the resolver. We declare the schema and point the engine at it.

## 2. Core abstractions

The engine recognizes five primitive concepts. Every type maps its domain nouns onto these.

| Primitive | Definition | General | EHR | Researcher |
|---|---|---|---|---|
| **Atom** | Timestamped, content-bearing unit | Memory | Encounter / Note / Observation | Tweet / PR / Release |
| **Entity** | Reusable referent (can be mentioned by many atoms) | Person/Concept/Project | Patient/Condition/Medication/Provider | Company/Product/Person |
| **Occurrence** | Atom → Entity link | MENTIONS | OBSERVED_IN / PRESCRIBED / TREATED_BY | ABOUT / MENTIONS |
| **Association** | Entity ↔ Entity link (typed, weighted) | ASSOCIATED | DIAGNOSED_WITH / CO_PRESCRIBED | ACQUIRED / WORKS_AT / PARTNER_OF |
| **Episode** (optional) | Group of atoms bound by time/context | Session | Admission / Visit | News cycle / Week |

Plus three universal edges:
- **SUPERSEDES** — correction trail (atom → atom)
- **SUMMARIZES** — semantic abstraction → atoms it distills
- **ALIAS_OF** — suspected / confirmed duplicate entity

## 3. Schema spec (what a type declares)

Each instance type ships a `SchemaSpec` like this:

```ts
interface SchemaSpec {
  // Atoms
  atomKinds: AtomKind[];           // e.g. ['memory'] for general; ['encounter','note','observation'] for ehr

  // Entities
  entityTypes: string[];           // closed enum, e.g. ['person','concept','project',...]

  // Associations (typed edges)
  associationKinds: AssocKind[];   // general: [{name:'ASSOCIATED', weighted:true}]
                                    // ehr: [{name:'DIAGNOSED_WITH', weighted:true}, ...]

  // Occurrences (atom → entity)
  occurrenceKinds: OccurrenceKind[]; // allowed predicates + their source/target atom/entity types

  // Episode config
  episodesEnabled: boolean;        // general: true, project-manager: false

  // Aging/tiering
  agingEnabled: boolean;           // general: true, ehr: false

  // Write mode
  writeMode: 'text' | 'structured' | 'both';

  // Prompts
  extractPrompt: (content: string) => string;

  // Resolver
  resolverConfig: ResolverConfig;  // weights, thresholds, context features

  // Maintenance
  maintenancePolicies: MaintenancePolicy[];
}
```

The engine reads this spec at initialization, builds the Kuzu schema accordingly, and routes every operation through these declarations.

## 4. Write path (engine-provided)

Two write modes, both go through the same single-writer lock.

### 4.1 Text mode — content arrives as a blob, LLM extracts entities

```
writeAtom({content, kind, salience, context, supersedes?}) {
  acquire_write_lock()
  try {
    episode_id = get_or_create_active_episode(context)   // if episodesEnabled
    atom = create_node(Atom, {
      id: uuid(), content, kind, salience,
      created_at, last_accessed, access_count: 0,
      tier: 'hot',                                        // if agingEnabled
      extracted: false,
      ...context                                          // source_instance, cwd, etc
    })
    if (episodesEnabled) link(atom, 'IN_EPISODE', episode_id)
    if (supersedes) for each: add SUPERSEDES edge + mark old.superseded_by
    enqueue_extraction_job(atom.id)
  } finally { release_write_lock() }
  return {id: atom.id}
}
```

### 4.2 Structured mode — content arrives with entities pre-identified

```
writeAtom({content, kind, salience, context, preExtracted}) {
  // Same as text mode, but skips the extraction queue.
  // Resolver still runs on preExtracted names to merge with existing entities.
  acquire_write_lock()
  try {
    atom = create_atom(...)
    for (e of preExtracted) {
      resolved = resolver.resolve(e.name, e.type, context)
      add_occurrence(atom, resolved, e.occurrenceKind, e.prominence)
    }
    update_associations(atom, resolved_entities)
    mark atom.extracted = true
  } finally { release_write_lock() }
}
```

### 4.3 Supersedes cue resolution

`supersedes` accepts either an atom id (explicit) or a cue string. For cue: the engine calls the type's query surface (e.g. `associate(cue, limit=3)`) and picks the top match. Types that don't expose an associate-like primitive disable cue supersedes.

## 5. Extraction worker (engine-provided)

Runs against any type that uses text-mode writes. Single process, polls the queue:

```
worker_loop() {
  while (running) {
    job = claim_next_queued_job()
    if (!job) { sleep(1000); continue }
    try {
      atom = get_atom(job.atom_id)
      entities = spec.llmExtract(atom.content)           // uses spec.extractPrompt
      embedding = llm_embed(atom.content)                // if spec.embeddingsEnabled

      acquire_write_lock()
      try {
        for (e of entities) {
          resolved = resolver.resolve(e.name, e.type, context_of(atom))
          MERGE atom -[OCCURS {prominence}]-> resolved
        }
        for (pair of pairs(entities)) {
          if (new_occurrence(pair)) {
            MERGE pair.a -[ASSOCIATION_KIND {++weight, last_reinforced}]-> pair.b
          }
        }
        update atom {embedding, extracted: true}
      } finally { release_write_lock() }

      mark job done
    } catch (err) {
      if (job.attempts >= 5) mark_failed(job, err)
      else requeue(job, backoff: 2^attempts)
    }
  }
}
```

## 6. Resolver (engine-provided, type-parameterized)

Two-step: candidate retrieval + fit scoring. Weights come from the type's `ResolverConfig`.

```
resolve(name, type, context) {
  candidates = union(
    fts_match(Entity.name + Entity.aliases, name, k=10),
    vector_search(Entity.embedding, embed(name), k=10)
  )
  if (candidates.empty) return create_entity(name, type)

  for (c of candidates) {
    c.fit_score = Σ spec.resolverConfig.weights[featureName] * featureValue(c, context)
    // Standard features: name_similarity, recency, context_overlap,
    //                    cwd_instance_match, type_match
    // Types can override or add features.
  }

  top = max(candidates, by: fit_score)
  if (top >= spec.resolverConfig.acceptThreshold) return existing(top)
  if (top >= spec.resolverConfig.uncertainThreshold) {
    new = create_entity(name, type)
    link new -[ALIAS_OF {status: suspected, confidence: top.fit_score}]-> top
    return new
  }
  return create_entity(name, type)
}
```

**Types tune by config, not by code.** EHR uses stricter thresholds (never merge wrong patients) than general. Researcher might weight industry cluster more heavily than name similarity.

## 7. Read-path reconsolidation (engine-provided, optional)

If a type's `SchemaSpec.reconsolidationEnabled: true`, every Atom read by retrieval primitives gets:
- `last_accessed = now`
- `access_count += 1`
- Possible tier promotion (cold→warm, warm→hot) — only if `agingEnabled`

Additionally, when a retrieval returns multiple atoms, the engine strengthens associations between their entities ("thinking together reinforces"). Controlled by `retrievalCoActivationEnabled`.

Batched + committed at end-of-call (one lock acquisition).

## 8. Aging / tiering (engine-provided, optional)

When `agingEnabled: true`:

| Tier | Age     | Access threshold    | Retrieval cost penalty |
|------|---------|----------------------|------------------------|
| hot  | <7d     | or accessed ≥3× total | 0 (fully indexed)     |
| warm | 7-90d   | or accessed ≥2×      | light (vector only)    |
| cold | 90d+    | never-refreshed      | heavy (metadata only)  |

Nightly maintenance recomputes tiers. Retrieval scoring multiplies by tier weight. Nothing is ever deleted.

When `agingEnabled: false`, `tier` column isn't materialized and retrieval doesn't apply tier weight. EHR turns this off — a patient's 5-year-old diagnosis is fully relevant when they return.

## 9. Maintenance (engine-provided, policy-driven)

The engine runs maintenance passes on three cadences (nightly/weekly/monthly). Types declare which passes run and configure their parameters.

Available passes:

- **Tier recomputation** (`if agingEnabled`) — O(N) tier column update
- **Alias confirmation** — LLM checks suspected `ALIAS_OF` edges, collapses confirmed ones
- **Near-duplicate detection** — embedding-similarity clustering, adds `REINFORCED_BY` edges, marks dups as lower priority
- **Semantic summary generation** — clusters atoms by shared entities + timeframe, generates summary atoms with `SUMMARIZES` edges (`if spec allows`)
- **Index refresh** — Kuzu FTS rebuild for new data
- **Theme/category consolidation** (monthly) — community detection over associations, creates category entities, adds `IS_A` edges
- **Aging audit** (monthly, `if agingEnabled`) — flags long-unused atoms as archived

Each type configures which passes run, how often, and with what thresholds. General runs all of them. EHR runs alias confirmation + discharge-summary-style summarization, skips aging-related passes. Project-manager might run only alias confirmation + theme detection.

## 10. Single-writer lock (engine-provided)

File-based flock at `<dbPath>/../write.lock`. Acquired by every write path (Phase A, extraction worker Phase B, maintenance passes). Releases are tight — bursts of ms to sub-second. One DB per lock; different instances have their own locks.

## 11. Extraction queue (engine-provided)

Persistent queue as a node table in the Kuzu DB itself:

```
ExtractionJob {
  id, atom_id, queued_at, attempts, status, error?
}
```

Status: `queued | in_progress | done | failed`. Worker uses atomic claim (`SET status='in_progress' WHERE status='queued'`). Crash-resilient (stale `in_progress` jobs after 5min get reset to `queued`).

## 12. Failure resilience (engine-provided)

| Failure | Behavior |
|---|---|
| LLM unavailable | Job stays queued with backoff; caller's write returned long ago |
| Worker dies mid-job | Job marked `in_progress` but stale; reset to queued after 5min |
| DB lock held too long | Instrumented; alerts if >1s |
| LLM returns garbage | Fallback: regex + capitalized-word heuristic (text mode only); atom marked partially-extracted |
| Concurrent writes | Serialized by lock |

## 12.5 Ingestion and routing (no central orchestrator)

Per-instance ingestion is the default. Each instance declares its own source subscriptions (which Slack channels, which Twitter queries, which GitHub repos) and owns its ingestion pipeline. The pipeline normalizes content into atoms, calls `writeAtom` (text mode if LLM extraction is needed, structured mode if entities arrive pre-identified from the source API), and the engine's async extraction worker handles the rest — same worker that processes session consolidates.

**Per-atom extraction (e.g., "what is this tweet saying?"):**
- Ingestion calls `writeAtom({content, kind})`
- Worker enqueues, extracts entities via `@anagnole/claude-cli-wrapper`, resolves against existing Entities, writes MENTIONS + bumps CO_OCCURS
- Batching: ingestion pipelines can use `writeAtoms([...])` to bulk-enqueue; the worker groups LLM calls (e.g. 20 at a time) for cost efficiency

**Cross-atom summaries (e.g., "this week in AI news"):**
- Handled by maintenance passes (§9), not a separate pipeline
- Types declare which summarization passes to run and with what prompts

**Shared-source routing is optional and static by default.** When one source has content belonging to multiple instances (e.g. one Slack workspace split by channel), each instance's source config declares its subset. No LLM routing needed. A dynamic LLM-based router remains possible for genuinely ambiguous cases but is opt-in, not the default.

**No central orchestrator subprocess.** The old fan-out pattern (one shared ingestion → Claude CLI subprocess routes each message across children) is superseded by per-instance ingestion + cascade (child-to-parent dual-writes, see cascade notes in the general instance doc). Implementation cleanup: `src/orchestrator/` can be removed unless the dynamic LLM router is explicitly needed.

## 13. What the engine does NOT provide

Engine stops where type semantics begin:

- **Query surface** — each type writes its own retrieval functions (`associate`/`recall_episode` for general, `find_cohort`/`aggregate_observation_for_cohort` for ehr). The engine supplies the primitives these functions traverse (Atom, Entity, edges, FTS index, vector index) but not the domain-specific ranking.
- **Extract prompts** — type-specific; the engine calls the spec's `extractPrompt`.
- **Schema names** — Memory vs Encounter vs Tweet is cosmetic in the Kuzu DDL. Types declare their node label; the engine uses what's declared.
- **Resolver weights + thresholds** — type-specific tuning.
- **What counts as an episode** — types decide.

## 14. Scaling considerations (engine-provided)

| Graph size | Primary mechanism |
|---|---|
| <1K atoms | Everything works without optimization |
| 1K–10K | Aging tiers (if enabled) matter; nightly maintenance indispensable |
| 10K–100K | Semantic summaries dominate retrieval for older data |
| 100K–500K | Themes/categories become primary navigation |
| 500K+ | Archive DB split — `archive/kuzu/` for very-old atoms |

All of this is in the engine; types opt in via their `SchemaSpec`.

## 15. Directory layout (target after split)

```
src/graph-engine/
  types.ts                  — Atom, Entity, Occurrence, Association, Episode; SchemaSpec
  write-path.ts             — writeAtom (text + structured)
  resolver.ts               — fuzzy + fit-score + decide
  worker.ts                 — extraction worker loop
  reconsolidation.ts        — read-side weight bumping
  maintenance/
    registry.ts             — available passes
    tier-recompute.ts
    alias-confirm.ts
    dedupe.ts
    summarize.ts
    theme-detect.ts
    aging-audit.ts
  lock.ts                   — single-writer file lock
  queue.ts                  — ExtractionJob table helpers
  llm.ts                    — shared ClaudeCliProvider singleton
  index.ts                  — public exports

src/instances/
  general/
    schema.ts               — SchemaSpec for general
    extract-prompt.ts
    resolver-config.ts
    maintenance-config.ts
    functions.ts            — working_memory, associate, recall_episode, consolidate
  ehr/                      (future)
  researcher/               (future)
  coding/                   (future)
  project-manager/          (future)
```

The existing `src/graphstore/` directory becomes `src/graph-engine/` (rename) with the per-type adapters moving under `src/instances/`.

## 16. Build order with the split

Revised from the original graph-management plan:

**MVP:**
1. Engine core: `types.ts`, Kuzu schema builder from `SchemaSpec`, `write-path.ts` (text mode only), `lock.ts`, `queue.ts`
2. General's `SchemaSpec` + `extract-prompt.ts`
3. `worker.ts` for text-mode extraction
4. `resolver.ts` with general's resolver config
5. General's `functions.ts` — working_memory, recall_episode (both answerable without entities), then associate once entities exist
6. `reconsolidation.ts`
7. Session lifecycle (Episode create/close)
8. SessionEnd extractor (general-instance-graph.md)

**Post-MVP:**
9. Structured-mode writes (unlocks EHR's direct FHIR ingestion)
10. Embeddings + vector index
11. Maintenance passes (registry + each pass, wired into general's config)
12. Supersedes cue resolution
13. Cross-instance cascade

**Later (per-type builds):**
14. EHR SchemaSpec + config + functions
15. Researcher SchemaSpec + config + functions
16. Coding / project-manager / manager

Each new type after general is mostly declarative config — no new engine code needed unless it surfaces a leak.

## 17. Open questions

- **Embedding model** — one for the whole system, or per type? Probably one (OpenAI text-embedding-3-small is fine everywhere).
- **Vector index implementation** — Kuzu's built-in vector support, or external? Start with Kuzu's; evaluate.
- **SchemaSpec validation** — runtime check that a type's spec is coherent (e.g., occurrenceKinds reference declared atom/entity kinds). Zod schema on SchemaSpec.
- **Generic vs typed MERGE** — Kuzu's MERGE semantics are per-table. The engine generates the per-table MERGE queries from the SchemaSpec at initialization.
