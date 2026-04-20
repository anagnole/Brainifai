# General Instance Graph — Concrete Configuration

Status: concrete application of the graph engine for the always-on general instance. Depends on `graph-engine.md`.

## 1. What this instance is for

The "general" instance is the user's long-term cognitive substrate — the always-on brain-like knowledge graph. Every session's key decisions and insights land here. Every non-general instance cascades its session summaries here. Over years, it becomes the integrated life-log.

**Success criteria at scale:**

- Year 1 (~15K memories, ~4K entities): `associate(cue)` returns relevant results in <300ms
- Year 2 (~40K memories): retrieval *improves* because semantic summaries absorb repetition
- Year 5 (~200K memories): feels like a well-organized brain, not a dumping ground

## 2. Schema spec

```ts
export const generalSchema: SchemaSpec = {
  atomKinds: ['memory'],   // single atom kind; subkind in content metadata

  entityTypes: [
    'person', 'project', 'tool', 'place', 'concept',
    'category', 'topic', 'other'
  ],

  associationKinds: [
    { name: 'ASSOCIATED', weighted: true },   // generic co-occurrence
    { name: 'IS_A', weighted: false },         // Brainifai IS_A project
  ],

  occurrenceKinds: [
    { name: 'MENTIONS', atom: 'memory', entity: '*', hasProminence: true },
  ],

  episodesEnabled: true,
  agingEnabled: true,
  reconsolidationEnabled: true,
  retrievalCoActivationEnabled: true,
  writeMode: 'text',
  embeddingsEnabled: true,

  extractPrompt: generalExtractPrompt,
  resolverConfig: generalResolverConfig,
  maintenancePolicies: generalMaintenancePolicies,
};
```

### 2.1 Atom: Memory

```
Memory {
  id: STRING (PK)                   // uuid
  content: STRING
  kind: STRING                      // see kind taxonomy below
  salience: STRING                  // 'low' | 'normal' | 'high'
  created_at, last_accessed: STRING
  access_count: INT
  source_instance, cwd: STRING      // context binding
  source_kind: STRING               // 'consolidate' | 'session-summary' | 'ingestion' | 'cross-instance'
  tier: STRING                      // hot | warm | cold (computed)
  embedding: FLOAT[]                // populated async
  extracted: BOOLEAN
  superseded_by: STRING             // nullable id
  foreign_episode: STRING           // JSON {instance, episode_id} when source_kind='cross-instance'; nullable otherwise
}
```

**Kind taxonomy** (free-form, but recognized values structure retrieval):
- `decision` — explicit decision
- `insight` — observation worth remembering
- `observation` — neutral fact
- `preference` — user's stated preference
- `bug-fix` — resolved issue context
- `conversation` — snippet of dialog
- `session-summary` — generated at T=N
- `semantic-summary` — maintenance-generated, abstracts a cluster
- `theme` — top-level theme, monthly/quarterly
- `correction` — retraction, always has SUPERSEDES edge

### 2.2 Entity

```
Entity {
  id: STRING (PK)
  name: STRING                      // canonical
  type: STRING                      // see entityTypes above
  first_seen, last_seen: STRING
  mention_count: INT
  aliases: STRING[]                 // denormalized for fast match
  embedding: FLOAT[]
  status: STRING                    // 'active' | 'merged' | 'archived'
}
```

### 2.3 Episode (session)

```
Episode {
  id: STRING (PK)
  start_time, end_time: STRING
  source_instance, cwd: STRING
  summary_memory_id: STRING         // filled at SessionEnd
  message_count: INT
  closed: BOOLEAN
}
```

### 2.4 Edges

Engine-provided:
- `Memory -[MENTIONS {prominence}]-> Entity`
- `Memory -[IN_EPISODE]-> Episode`
- `Memory -[SUPERSEDES]-> Memory`
- `Memory -[SUMMARIZES]-> Memory`
- `Entity -[ASSOCIATED {weight, last_reinforced}]-> Entity`
- `Entity -[IS_A]-> Entity`
- `Entity -[ALIAS_OF {confidence, status}]-> Entity`

### 2.5 Indexes

- FTS on `Memory.content` (hot tier only; rebuilt nightly)
- FTS on `Entity.name` + `Entity.aliases` (always)
- Vector on `Memory.embedding` (hot + warm tiers)
- Vector on `Entity.embedding`
- B-tree on `Memory.(source_instance, cwd, created_at)` — location-bound recall
- B-tree on `Memory.(last_accessed)` — working_memory
- B-tree on `Memory.(extracted, created_at)` — worker polling

## 3. Write sources

Three write paths all converge on the engine's `writeAtom` (text mode).

### 3.1 Session consolidates (primary)

- **Explicit**: user types `/remember`, or Claude mid-session calls `consolidate()` when detecting a decision. Salience = `high` (explicit) or `normal` (auto). Rate: ~0–5 per session.
- **Batch at T=N**: session-end orchestrator calls Claude Haiku via `@anagnole/claude-cli-wrapper` with the transcript, parses `{content, kind, salience}[]` + one session summary. Session summary gets `kind='session-summary'` with `SUMMARIZES` edges to the session's other memories. Rate: ~3–15 per session.

### 3.2 Cross-instance cascade (mid-session, not just SessionEnd)

**Every** consolidate in a non-general instance dual-writes to general — not just SessionEnd summaries. This keeps general's `working_memory` populated with project-scoped activity so session continuity works regardless of which folder the user is in.

Mechanics:
- Child's `consolidate()` performs its local writeAtom as usual
- Additionally, calls `writeAtom` on general's graph with:
  - `source_kind='cross-instance'`
  - `source_instance=<origin child name>`
  - `cwd=<child session cwd>`
  - `foreign_episode={instance: <origin>, episode_id: <child episode id>}` — provenance pointer instead of a local `IN_EPISODE` edge in general

**Why foreign_episode instead of IN_EPISODE?** No general-side session exists during a cross-instance write (general isn't the active instance). Creating a shadow episode in general would pollute episodic recall. Keeping the reference in metadata preserves provenance — `recall_episode` in general can surface cross-instance memories and point back at the child's episode for full detail.

At SessionEnd, the child may additionally push a summary atom (`kind='session-summary'`) to general — that's redundant after per-consolidate cascades but useful for coarse-grained retrieval.

### 3.3 Personal streams (optional)

Calendar, journal, voice memos, Apple Shortcuts events. All enter via the same `consolidate()` path with `source_kind='ingestion'`. Parked for the ingestion chapter.

## 4. Retrieval functions (what the type exposes)

The four brain-inspired primitives from `context-building.md`, implemented on the engine's graph primitives.

### 4.1 `working_memory({scope, limit})`

```
find Atom filter (scope==='here' ? cwd=current : no_filter)
  order last_accessed desc
  limit N
  bump_reconsolidation(weight: 0.3)  // light touch
```

**`scope:'here'` is a first-class case, not a rare override.** Because every child's consolidate cascades to general with the child's `cwd`, general's graph has project-tagged memories for any folder the user has worked in. Filtering by current cwd returns local-project continuity; filtering by none returns cross-project continuity. The T=0 hook calls both scopes and presents them as two sections.

### 4.2 `associate({cue, limit})`

```
cue_entities = resolve_cue_to_entities(cue)            // FTS + vector + content match
activated = spread_activation(cue_entities, hops: 2)    // CO_OCCURS-weighted

memory_scores = {}
for (e, entity_score in activated)
  for (m via MENTIONS {prominence})
    memory_scores[m.id] += entity_score
                         * m.prominence
                         * tier_weight(m.tier)
                         * salience_weight(m.salience)
                         * recency_decay(m.last_accessed)
                         * (1 / (1 + access_count * 0.01))  // saturation

memories = top_k filter !superseded_by
bump_reconsolidation(memories, weight: 1.0)             // strong
reinforce_co_associations_between(retrieved_entities)    // "thinking together"
```

Two-hop spread only (three-hop gets noisy). Tier weight, saturation, and reconsolidation are engine-provided; this function composes them.

### 4.3 `recall_episode({cue?, when?, where?, kind?})`

```
episodes = find Episode filter when ∧ where
memories = atoms_in(episodes) filter kind
if (cue) rerank by cue-entity activation
bump_reconsolidation(memories, weight: 0.8)  // deliberate recall
```

### 4.4 `consolidate({content, kind?, salience?, supersedes?})`

Thin wrapper over engine's `writeAtom`:

```
writeAtom({
  content, kind: kind ?? 'observation',
  salience: salience ?? 'normal',
  context: {source_instance, cwd, source_kind: 'consolidate'},
  supersedes,   // engine resolves cue→ids via associate if string provided
})
```

## 5. Resolver config

```ts
export const generalResolverConfig: ResolverConfig = {
  weights: {
    name_similarity:     0.35,
    recency:             0.15,
    context_overlap:     0.30,   // co-entities in this memory sharing CO_OCCURS with candidate
    cwd_instance_match:  0.10,
    type_match:          0.10,
  },
  acceptThreshold:    0.75,
  uncertainThreshold: 0.50,
};
```

Rationale: general's graph is messy by design (personal, broad). Medium thresholds. Tightens over time as graph matures.

## 6. Extraction prompt

```ts
export const generalExtractPrompt = (content: string) => `
Extract named entities from the following memory.

Memory: """${content}"""

Return a JSON array: [{ "name": "...", "type": "person|project|tool|place|concept|category|topic|other", "prominence": 0..1 }]

- Resolve pronouns (e.g. "he" → the named person if clear from context; otherwise skip).
- Prominence is how central this entity is to the memory (0.9 for the subject, 0.3 for passing mentions).
- Skip purely generic terms ("thing", "idea", "person" without a name).
- Return only the JSON array. No markdown, no commentary.
`;
```

Used by the engine's worker in text mode.

## 7. Maintenance policies

### Nightly (3am, <10min target)

- **Tier recomputation** — hot/warm/cold
- **Alias confirmation** — LLM check on `ALIAS_OF {status:'suspected'}` edges created today; collapse confirmed
- **Near-duplicate detection** — embedding cosine >0.92 within 30d; add `REINFORCED_BY`, mark dups
- **FTS refresh** — rebuild on hot-tier subset

### Weekly (Sunday 4am, <30min target)

- **Semantic summary generation** — cluster 5+ memories sharing 2+ entities within last week; spawn LLM summary; write `kind='semantic-summary'` + `SUMMARIZES` edges
- **Full FTS rebuild** — entire Memory + Entity
- **Weekly roll-up** — LLM generates one paragraph week-in-review

### Monthly (1st at 5am, <2h target)

- **Theme detection** — community detection over ASSOCIATED edges; name each cluster; write `kind='theme'` with `IS_A` from constituent entities
- **Category consolidation** — create/promote `category` entities; add `IS_A` edges
- **Aging audit** — flag very-old unreferenced memories as `status='archived'`
- **Embedding refresh** (manual only in v1) — rebuild if model upgraded

All use engine-provided primitives; only the policies + prompts are general-specific.

## 8. Timeline use cases

See `graph-management.md` section 8 (to be migrated here). Walks through day 1 → year 5 behavior.

## 9. MVP build order

From `graph-engine.md` §16 — general-specific slice:

**MVP:**
1. General's `SchemaSpec` declaration
2. General's `extract-prompt.ts`
3. Episode lifecycle hooks (SessionStart/End creates + closes Episode)
4. `working_memory()` and `recall_episode()` (no entities required)
5. SessionEnd extractor via `@anagnole/claude-cli-wrapper`
6. `consolidate()` wrapper over `writeAtom`
7. `associate()` once worker has populated entities
8. `/remember`, `/recall`, `/where` skills wired over these functions

**Post-MVP:**
9. Supersedes cue resolution (needs associate)
10. Cross-instance cascade (hook SessionEnd in every type to optionally write to general)
11. Maintenance policies active

## 10. Open general-specific questions

- **Extraction prompt iteration** — first week of real use will show blind spots. Version the prompt, log outputs, iterate.
- **Pronoun resolution** — "he/she/they" in memories. First pass: ask LLM to resolve from context. If that fails, skip the entity rather than creating "he" as an entity.
- **Threshold tuning** — 0.75/0.50 is a starting point. Observe merge quality over first month; adjust.
- **`/remember` vs auto-consolidate ratio** — LLM's auto-consolidate needs a sharp tool description. If it under-fires, users lean on `/remember` (fine). If it over-fires, the graph gets noisy.
