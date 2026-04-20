# Session Lifecycle, Hooks & Skills — Design Decisions

Status: decided on 2026-04-17. Covers how Brainifai fires context retrieval and memory writes across a Claude Code session, and what user-facing slash commands exist.

## 1. Principles

- **Three lifecycle moments**: SessionStart (T=0), UserPromptSubmit (T=1), SessionEnd (T=N). Each has its own orchestrator file.
- **Pluggable per-type contributions.** Each instance type declares lifecycle handlers alongside its context functions. Orchestrators iterate active instances and compose their contributions. Adding a new type never requires editing an orchestrator.
- **One file per moment, short and readable.** Behavior at any moment is changed by editing one file. No hidden dispatch, no buried abstractions.
- **Lazy retrieval mid-session, eager capture at session end.** Claude decides what to retrieve; the lifecycle guarantees capture as the session closes.
- **No per-instance lifecycle overrides.** Type-level granularity is enough — keeps things simple.

## 2. Architecture

### 2.1 Per-type lifecycle handlers

Each instance type exports a lifecycle object alongside its context functions, in the same file:

```ts
// src/context/functions/general.ts

export const workingMemoryFn: ContextFunction = { ... };
export const associateFn: ContextFunction = { ... };
export const recallEpisodeFn: ContextFunction = { ... };
export const consolidateFn: ContextFunction = { ... };

export const generalLifecycle: LifecycleHandlers = {
  onSessionStart: async (ctx) => ({
    block: formatWorkingMemory(await workingMemory({ scope: 'global' }, ctx.store))
  }),
  onSessionEnd: async (ctx) => ({
    writes: await extractDecisionsAndConsolidate(ctx.transcript, ctx.store)
  }),
  // onUserPrompt: omitted — general instance is lazy at T=1
};
```

Handler interface:

```ts
interface LifecycleHandlers {
  onSessionStart?: (ctx: LifecycleContext) => Promise<{ block?: string }>;
  onUserPrompt?:   (ctx: LifecycleContext) => Promise<{ block?: string }>;
  onSessionEnd?:   (ctx: LifecycleContext) => Promise<{ writes?: number }>;
}

interface LifecycleContext {
  instance: InstanceConfig;
  store: GraphStore;
  cwd: string;
  transcript?: string;    // only at SessionEnd
  userPrompt?: string;    // only at UserPromptSubmit
}
```

### 2.2 Per-moment orchestrator

One file per moment in `src/lifecycle/`. Each is short enough to audit at a glance:

```ts
// src/lifecycle/session-start.ts  — the pattern, roughly
export async function onSessionStart(ctx): Promise<string> {
  const instances = readFolderConfig(ctx.cwd).instances;
  const blocks: string[] = [];

  // 1. Positional block always first (sourced from config, no tool calls)
  blocks.push(composePositionalBlock(instances, ctx));

  // 2. Each active instance type contributes
  for (const inst of instances) {
    const handlers = lifecycleRegistry.get(inst.type);
    const out = await handlers?.onSessionStart?.({ instance: inst, ...ctx });
    if (out?.block) blocks.push(out.block);
  }

  return blocks.join('\n\n---\n\n');
}
```

Orchestrator files:

| File                               | Fires on                  |
|------------------------------------|---------------------------|
| `src/lifecycle/session-start.ts`   | Claude Code SessionStart  |
| `src/lifecycle/user-prompt.ts`     | Claude Code UserPromptSubmit |
| `src/lifecycle/session-end.ts`     | Claude Code SessionEnd    |

### 2.3 Lifecycle registry

Mirrors the context function registry — each type registers its handlers at module load:

```ts
// src/lifecycle/registry.ts
lifecycleRegistry.register('general', generalLifecycle);
lifecycleRegistry.register('coding', codingLifecycle);
lifecycleRegistry.register('researcher', researcherLifecycle);
// ...
```

## 3. Per-moment behavior (defaults)

### T=0 — SessionStart

**Always fires (from orchestrator, not a type):**
- Compose positional block from config: folder, instances in this folder, tree position, recent activities snapshot.
- **Call general twice for working memory and merge:**
  - `local_tail = general.working_memory({scope: 'here', limit: 8})` — memories tagged with current cwd
  - `global_tail = general.working_memory({scope: 'global', limit: 8})` — cross-project recent
  - Dedupe, sort by recency, render as two sections in the T=0 block ("Recent here" / "Recent globally")

Because every child's `consolidate` cascades to general with its cwd, general has project-scoped memories for every folder the user has worked in. `scope:'here'` returns local-project continuity even when the active instance is not general.

**Per-type contributions:**
- **general:** no extra contribution needed — the orchestrator already pulls its working_memory above.
- **coding:** calls `get_project_context()` to auto-familiarize Claude with the project. Replaces the manual "familiarise yourself with the project" step.
- **researcher / ehr / manager / project-manager:** no default contribution (add later if needed).

### T=1 — UserPromptSubmit

**Default: empty.** Claude decides what to retrieve based on the prompt, using tool descriptions.

Rationale: eager pre-association costs tokens on every prompt and is often irrelevant for trivial prompts ("run the tests", "fix the typo"). Flipping to eager later = add a few lines to `user-prompt.ts`.

### T=N — SessionEnd

**Per-type contributions for eager capture:**

- **general:** calls Claude Haiku via `@anagnole/claude-cli-wrapper` with the session transcript + an extraction prompt. Returns a JSON list of `{ content, kind, salience }`. Each entry becomes a `consolidate()` call, which (for non-general sessions) cascades to general. A higher-level `kind='session-summary'` atom is generated alongside, with `SUMMARIZES` edges to the individual extracts. Also pushes a snippet to each touched instance's `recentActivities` for peer visibility.
- **coding:** optionally logs session-level observations (touched files, decisions about architecture) — TBD as coding type's design firms up.

Note: mid-session consolidates already cascade to general per the cascade mechanism in `general-instance-graph.md`. SessionEnd is the coarse-grained backup summary, not the only source of cross-instance continuity.

Rationale for subprocess over heuristic: session-end isn't latency-sensitive (user is leaving), and quality matters — this is the only safety net against losing session context. Heuristic scanning misses nuance and produces noisy writes.

## 4. Skills (user-invoked slash commands)

Three skills locked for v1:

### `/remember <content>`
Shortcut to `consolidate(content=<input>, salience='high')`. User types the gist; it becomes a high-salience memory. Confirms "saved" on completion.

### `/recall <cue>`
Shortcut to `associate(cue=<input>)`. Returns ranked related memories inline in the chat, so the user sees the KG's answer directly rather than asking Claude to retrieve.

### `/where`
No args. Re-dumps the T=0 positional block (folder, instances, tree, recent activities). Use when the session has drifted and orientation is lost.

## 5. Deferred / dropped

- **`/episode` and `/forget` skills** — not shipped. `/recall` + natural language cover the episode case; `consolidate(supersedes=...)` covers correction without needing a dedicated skill.
- **Per-instance lifecycle overrides** — type-level granularity is the rule. Revisit only if a concrete need arises.
- **T=1 eager association** — not implemented by default. Easy to enable later with a one-file edit.
- **Heuristic extractor at SessionEnd** — rejected in favor of calling Claude via `@anagnole/claude-cli-wrapper`.
- **Per-turn (PostToolUse) auto-consolidation** — rejected. Captures speculation as if it were decided.

## 6. Open for later

- Exact extraction prompt for the SessionEnd subprocess (engineer when implementing).
- Whether the coding type contributes at SessionEnd (probably yes — needs spec).
- How `working_memory` and `consolidate` are actually graph-backed — covered in the ingestion chapter.
