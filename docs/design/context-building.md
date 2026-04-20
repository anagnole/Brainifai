# Context Building — Design Decisions

Status: decided on 2026-04-17. Covers what context functions exist, how they're scoped to instances, and what the LLM sees at session start.

## 1. Principles

- **Context retrieval is brain-inspired for the general instance.** Working memory, spreading activation, episodic recall, consolidation — four primitives that cover the retrieval surface without feature bloat.
- **Ambient properties do the work of many extra args.** Recency decay, cwd/context binding, reconsolidation side-effects on read, and salience weighting are built into the retrieval layer — not exposed as function arguments.
- **Tool descriptions teach the LLM how to use each tool.** No per-type system-prompt boilerplate is injected. MCP tool descriptions + a single hook-injected positional block are all Claude sees at T=0.
- **Positional metadata is hook-injected, not a tool call.** "Where am I, what instance, what's in the tree" is read from config at session start and injected once. Re-reading is free.

## 2. What Claude sees at T=0

Two surfaces, nothing else:

1. **MCP tool list** — tools from every instance in the resolved folder, namespaced `<instance-name>.<tool>`. Each tool's description teaches its own use.
2. **One hook-injected context block** — positional state only:
   - Folder + instances present here
   - Tree: parent, children, siblings-in-folder
   - Recent activities snapshot (from `recentActivities` in each instance config)
   - Portfolio (when inside global; local tree when inside a project)

No per-type "how to use me" system prompt. No per-instance `prompt.md` files.

## 3. Global pool — available to every instance

Tree-traversal primitives are universal (every instance may need to reach beyond itself):

- **`get_broader_context(query)`** — climb the tree: ask parent instance(s) for context beyond this scope. Returns parent's results or a timeout note.
- **`get_narrower_context(query)`** — fan down: parent delegates query to matching children via the event bus, aggregates responses.

Both are implemented via the existing event bus + tree-query coordinator.

Note: `get_instance_meta` was considered but **dropped** — the T=0 hook injection delivers the same information statically from config, which is correct 100% of the time for this data (names, types, descriptions don't change mid-session).

## 4. General instance — the always-on default

The "general" type is the always-on root-of-tree default instance. Its job is session continuity: short-term memory, cross-project association, episodic recall, decision capture. It is modeled as a brain-like knowledge graph.

### 4.1 Functions (4 total)

#### `working_memory`

```
working_memory({
  scope?: 'global' | 'here',     // default 'global'
  limit?: number,                // default ~15, max ~50
})
→ [{ timestamp, content, kind, source_instance, how_recent }]
```

Item-bounded scratchpad tail. Returns the N most-recent items (not time-bounded — brains don't forget your last thought after a weekend, they just feel it as "a while ago"). `scope: 'here'` filters to current cwd/instance; default is the user's global stream.

#### `associate`

```
associate({
  cue: string,                   // required
  limit?: number,                // default ~10, max ~30
})
→ [{ score, content, kind, when, where, source_instance }]
```

Spreading activation from a cue. Not fulltext search — graph-distance × recency × salience weighted. Cue is required (no-cue association is nonsense). All weighting is ambient; no time-window arg.

Subsumes "recognition": passing a pasted tweet/text as the cue answers "does this ring a bell?".

#### `recall_episode`

```
recall_episode({
  cue?: string,                  // optional — enables free recall by filters
  when?: string,                 // "last week", ISO range, or relative
  where?: string,                // cwd, instance name, or path
  kind?: string,                 // "decision" | "conversation" | etc
})
→ [{ when, where, who, content, kind }]
```

Episodic recall. Cue is optional so you can free-recall by category alone ("list all decisions from last month"). At least one filter must be present — enforced at runtime.

#### `consolidate`

```
consolidate({
  content: string,               // required
  kind?: string,                 // category tag
  salience?: 'low' | 'normal' | 'high',
  supersedes?: string,           // id or cue of prior memory this corrects
})
→ { id, superseded: string[] }
```

Write + reinforce + reconsolidate. `supersedes` lets a new entry mark prior traces as overridden (handles the "no, I didn't decide that — I was still debating" case without a separate `forget`). Topics/embeddings are auto-derived at ingestion — not the LLM's job.

### 4.2 Ambient properties (not args — retrieval-layer behavior)

- **Recency decay** — older items weight down
- **Context binding** — current cwd, current instance, and working-memory tail implicitly bias every retrieval
- **Reconsolidation side-effect** — every `associate` / `recall_episode` read touches `last_accessed` and compounds recency
- **Salience weighting** — `kind: 'decision'` and `salience: 'high'` surface first

### 4.3 Deferred / dropped

- **Dropped:** `search_entities`, `get_entity_summary`, `get_recent_activity`, `get_context_packet` from the old base set — subsumed by the 4 primitives above.
- **Dropped:** `recognize` as a separate function — `associate(cue=content)` covers it.
- **Dropped:** Explicit `forget` — brains don't truly forget on demand; `supersedes` handles correction.
- **Parked for ingestion discussion:** where `working_memory` reads from (graph-backed short-term nodes, separate from `config.recentActivities` which stays a peer-visibility snapshot).
- **Parked for ingestion:** what auto-populates short-term memory (SessionEnd hook? rolling transcript ingester?).

## 5. Other instance types

Each non-general type brings its own domain-specific functions. Planned but not yet specified in detail:

- **coding** — project familiarization (replaces manual "familiarize yourself with the project"), gitnexus bridge
- **researcher** — landscape, timeline, trending, entity network, search events
- **ehr** — cohort, observation concepts, aggregation, patient-centric queries
- **manager** — people context, meeting summary
- **project-manager** — portfolio health, cross-project impact

Functions across types do not share a naming convention (no forced polymorphism like "every type has `search`"). Tool namespacing (`<instance>.<tool>`) means collisions are impossible.

## 6. Open for later chapters

- Ingestion pipeline and graph structure per type
- Hooks & skills in the session lifecycle
- How `consolidate`'s `supersedes` resolves cue → id at write time
- How ambient context-binding is implemented (similarity re-ranking vs hard-filter)
