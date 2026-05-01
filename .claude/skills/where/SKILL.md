---
name: where
description: Show the current Brainifai instance context — what instance you're in, recent working-memory atoms, and what tools are available. Use when you're disoriented mid-session.
disable-model-invocation: true
---

# /where — Orient Me

Show the user where the current Claude session stands in terms of Brainifai context.

## Steps

1. **Call `working_memory`** with no args (`limit: 10`). These are the most-recently-accessed atoms — your short-term scratchpad.

2. **Call `working_memory` with `scope: "here"`** (limit 8) — atoms tagged with this project's cwd. These are project-local recents.

3. **Present the result in two sections**:
   - `### Recent (this project)` — the `scope: here` results
   - `### Recent (globally)` — the `scope: global` results, deduped against the local list

   Each item: `[kind] first 80 chars…`

4. **State the active instance** — the MCP tool's response reveals the active source_instance. Mention it at the top.

5. **If working_memory returns nothing**, say so clearly: "No recent memories in this context — start with `/remember` to capture your first."

## Notes

- This skill is the manual version of the SessionStart hook. Use it when you're mid-session and lost your bearings.
- It doesn't invoke any graph mutation — purely read-only orientation.
