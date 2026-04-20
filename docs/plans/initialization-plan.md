# Initialization — Technical Plan

Translates `docs/design/initialization.md` into concrete implementation steps.

## 0. What's changing vs current code

| Aspect                  | Current                                      | Target                                                |
|-------------------------|----------------------------------------------|-------------------------------------------------------|
| Config shape            | One `InstanceConfig` per `config.json`       | `FolderConfig { version, instances: [] }`             |
| Layout                  | `.brainifai/data/kuzu/`                      | `.brainifai/<instance-name>/data/kuzu/`               |
| Init flow               | CLI flags (`--name`, `--type`)               | Interactive prompts (type, workdir, name, description, populate) |
| Description             | Mechanical string concat                     | LLM-generated via `@anagnole/claude-cli-wrapper`, user-editable |
| Populate step           | None                                         | Per-template `populate: {script, prompt}` with runner |
| Resolution              | Returns one instance                         | Returns list; tool namespacing handles disambiguation |
| Migration               | —                                            | Wipe and re-init; detect old layout, error out        |

No backwards compatibility. Old layouts get an error with instructions to wipe and re-init.

## 1. Files to create / modify / delete

### New files
- `src/instance/folder-config.ts` — new `FolderConfig` read/write, replaces most of current `resolve.ts`'s config I/O
- `src/instance/populate.ts` — runner for populate scripts
- `src/scripts/populate-coding.ts` — populate script stub for coding type
- `src/scripts/populate-researcher.ts` — populate script stub for researcher type
- `src/scripts/populate-project-manager.ts` — populate script stub
- (EHR already has `populate-ehr.ts` pattern elsewhere; move or adapt — check)
- `src/instance/init-interactive.ts` — interactive prompts, LLM description generation
- `src/instance/__tests__/folder-config.test.ts`
- `src/instance/__tests__/init.test.ts`

### Modified files
- `src/instance/types.ts` — add `FolderConfig`; keep `InstanceConfig` but drop `parent/createdAt/updatedAt` from top-level (they move into each instance within FolderConfig — actually they stay per-instance, just the file structure changes)
- `src/instance/resolve.ts` — rewrite: `findFolderConfig`, `readFolderConfig`, `writeFolderConfig`, `resolveInstances`, `resolveInstance(name?)`
- `src/instance/init.ts` — rewrite: `initGlobalInstance` (one `general` instance in folder), `initProjectInstance` (adds to existing folder or creates)
- `src/instance/templates.ts` — add `populate?: {script, prompt}` field to `InstanceTemplate`
- `src/instance/descriptions.ts` — replace mechanical generator with LLM-based, keep mechanical as fallback
- `src/instance/registry.ts` — update `registerWithGlobal` for new layout; update `listInstances`/`searchInstances` if they read `.brainifai/config.json` anywhere
- `src/instance/skill-generator.ts` — generate SKILL.md aware of multi-instance per folder
- `src/cli/commands/init.ts` — wire to interactive flow
- `src/cli/commands/remove.ts` — update to remove instance from FolderConfig (not whole folder unless last)
- `src/cli/commands/list.ts`, `describe.ts`, `status.ts`, `doctor.ts` — update for multi-instance shape

### Deletion / deprecation
- Current `pushRecentActivity` at file level — move to operate on a specific instance within FolderConfig
- Old single-instance resolution fallbacks in `resolveInstanceDbPath` — reshape for multi-instance

## 2. Task order

Each task is ~30min to a few hours. Strict dependency order.

### Phase 1 — Types + folder-config I/O (foundation)

1. **Define `FolderConfig` type** in `src/instance/types.ts`. Fields: `version: 1`, `instances: InstanceConfig[]`. Keep `InstanceConfig` but remove the field duplication if any.
2. **Write `src/instance/folder-config.ts`**. Exports: `readFolderConfig(path)`, `writeFolderConfig(path, cfg)`, `addInstance(cfg, instance)`, `removeInstance(cfg, name)`, `findInstance(cfg, name)`. Pure functions + I/O.
3. **Rewrite `src/instance/resolve.ts`**:
   - `findFolderConfigPath(from)` — walk up from cwd to find `.brainifai/config.json`
   - `resolveInstances(from?)` — returns `{ folderPath, instances: InstanceInfo[] }`
   - `resolveInstance(from?, name?)` — returns single `InstanceInfo`; if name omitted and only one instance, returns it; if multiple and no name, throws
   - `resolveInstanceDbPath(from?, name?)` — per-instance DB path
   - Keep env overrides (`BRAINIFAI_INSTANCE_PATH`, `KUZU_DB_PATH`) but make them folder+name aware
4. **Write tests** for folder-config.ts (read roundtrip, add/remove, multi-instance). Also test resolve.ts walking behavior.

### Phase 2 — Templates with populate scaffold

5. **Extend `InstanceTemplate`** in `templates.ts` with optional `populate: { script: string; prompt: string }`.
6. **Populate stubs.** Create `src/scripts/populate-{coding,researcher,project-manager}.ts`. Each is a minimal file that reads instance path + dbPath from env/args and writes nothing yet (stub for future content).
7. **Wire populate field** in existing templates: `coding`, `researcher`, `ehr`, `project-manager` get populate references. `general`, `manager` omit it.
8. **Populate runner** in `src/instance/populate.ts` — `runPopulateScript(template, instancePath, dbPath)` spawns tsx subprocess, streams output. Returns exit code. Non-fatal on failure.

### Phase 3 — LLM description generator

9. **Rewrite `descriptions.ts`**. Export `generateDescription({name, type, workdir, sources})`:
   - Compose prompt: "Generate a 1-2 sentence description (<200 chars) for a Brainifai `<type>` instance named `<name>` covering `<workdir>`. Sources: ...".
   - Use `ClaudeCliProvider` from `@anagnole/claude-cli-wrapper` (already a dependency).
   - Follow the singleton pattern in `src/ingestion/researcher/extract.ts`: strip `ANTHROPIC_API_KEY` before construction so the subscription is used; `defaultModel: 'claude-haiku-4-5-20251001'`.
   - Timeout 30s.
   - Fallback to mechanical concat on failure.
   - Migrate `src/context/refinement.ts` to the same wrapper as part of this task (it currently uses `execFile('claude', ...)` — replace).

### Phase 4 — Init core (non-interactive)

10. **Rewrite `initGlobalInstance`**:
    - Error if `~/.brainifai/config.json` exists.
    - Create folder + `general/data/kuzu/`.
    - Generate `general` instance with LLM description.
    - Write FolderConfig with one instance.
    - Call `initializeInstanceDb(dbPath, 'general')`.
    - No registry registration for global itself.

11. **Rewrite `initProjectInstance({workdir, type, name, description, populate?})`**:
    - Require global exists.
    - Read existing FolderConfig if present; else start new.
    - Validate: name not already in this folder.
    - Resolve default name: `<basename(workdir)>-<type>`, collision-suffixed.
    - Create `<workdir>/.brainifai/<name>/data/kuzu/`.
    - Generate description via LLM if not provided.
    - Append instance to FolderConfig; write.
    - Call `initializeInstanceDb(dbPath, type)`.
    - Call `registerWithGlobal(name, type, description, instancePath, now)`.
    - If template has `populate` and user said yes, run populate script.
    - Update `.gitignore` (only if new — don't re-append).
    - Generate SKILL.md (multi-instance-aware).

12. **Collision handling**. If folder has existing `coding` instance and user tries to add another `coding`, auto-suffix name (`brainifai-coding-2`). Or reject — decide. Start with auto-suffix.

13. **Detect old layout.** If `<workdir>/.brainifai/data/kuzu/` exists (old single-instance layout), error with: "Old layout detected. Remove `<path>` and re-run init."

### Phase 5 — Interactive CLI

14. **Add prompts library.** Pick one: `prompts` (small, good) or `@inquirer/prompts` (MIT, active). Prefer `prompts` for MVP.
15. **Write `init-interactive.ts`**:
    - Prompt 1: instance type (select from template names)
    - Prompt 2: workdir (default cwd)
    - Prompt 3: instance name (default `<basename>-<type>`)
    - Prompt 4: description — show LLM-generated default, allow edit
    - Prompt 5: populate? (yes/no, only if template declares one)
    - Returns validated `InitProjectOptions`
16. **Wire `src/cli/commands/init.ts`**:
    - No args → interactive mode
    - `--global` → call `initGlobalInstance`
    - Flags still work as non-interactive overrides for scripting

### Phase 6 — Downstream CLI updates

17. **`remove.ts`** — accept instance name; if folder has other instances, remove just that one from FolderConfig + delete its subdir. If last instance, prompt to remove the whole `.brainifai/`.
18. **`list.ts`** — walk folders, print one row per instance.
19. **`describe.ts`** — take optional instance name; default to the folder's single instance or prompt if multiple.
20. **`status.ts`**, **`doctor.ts`** — iterate all instances in folder.

### Phase 7 — Registry & skill generator

21. **`registerWithGlobal`** — already keyed by name; no changes except `instancePath` now points to `<workdir>/.brainifai/<name>`, not `<workdir>/.brainifai`. Confirm.
22. **`skill-generator.ts`** — list all instances in the folder with their tools; don't hard-code one. Tool names become `<instance>.<tool>`.

### Phase 8 — Tests + manual verification

23. **Unit tests** — folder-config.ts (read/write/add/remove), resolve.ts (walking, multi-instance handling), templates.ts (populate field preserved).
24. **Integration test** — full init flow: global, project coding, add researcher to same folder, list, describe, remove one, remove last.
25. **Manual verification** — interactive flow, populate invocation, LLM description fallback.

### Phase 9 — Cleanup

26. Remove dead code paths that assumed single instance per folder.
27. Update `CLAUDE.md` with new layout (brief section) and new `brainifai init` usage.
28. Update `.env.example` if any env vars renamed.

## 3. Dependencies between phases

```
Phase 1 (types + folder-config) ─┬─► Phase 2 (templates + populate)
                                 ├─► Phase 3 (descriptions)
                                 └─► Phase 4 (init core)
                                              │
Phase 4 ─► Phase 5 (interactive CLI) ─► Phase 6 (downstream CLI)
                                              │
                                              └─► Phase 7 (registry + skill gen)
                                                              │
                                                              └─► Phase 8 (tests)
                                                                          │
                                                                          └─► Phase 9 (cleanup)
```

Phases 2 and 3 are parallelizable after Phase 1. Phases 6 and 7 can overlap.

## 4. Test plan

### Unit

- `folder-config.test.ts`:
  - Round-trip write → read
  - `addInstance` to empty/existing folder
  - `removeInstance` keeps others
  - `findInstance` by name
- `resolve.test.ts`:
  - `findFolderConfigPath` walks up correctly
  - Stops at global path
  - Returns null when no match
  - `resolveInstance` with/without name, with one/many instances
  - ENV overrides respected
- `descriptions.test.ts`:
  - LLM path uses execFile mock
  - Fallback path on timeout/error
  - Max length enforcement

### Integration

- `init.test.ts`:
  - `initGlobalInstance` creates expected layout
  - `initProjectInstance` creates new folder + instance
  - `initProjectInstance` a second instance into same folder → two subdirs, two entries in FolderConfig
  - Populate runs if requested (use a trivial stub populate script)
  - Old-layout detection throws
  - Name collision auto-suffix works
- `remove.test.ts`:
  - Remove one of two instances → other survives
  - Remove last instance → folder option prompt
- CLI E2E (optional for MVP): spawn `brainifai init --global`, `brainifai init --type general`, verify output layout.

### Manual

- Run interactive `brainifai init` end-to-end.
- Verify LLM description quality for each type.
- Verify populate script invocation (start with stubs that just echo).
- Verify SKILL.md generation points at the right tools.

## 5. Acceptance checklist

- [ ] `~/.brainifai/config.json` is a FolderConfig with one `general` instance.
- [ ] `~/.brainifai/general/data/kuzu/` exists and is a valid Kuzu DB.
- [ ] `cd <project>; brainifai init` walks through 5 prompts, creates `<project>/.brainifai/config.json` + `<project>/.brainifai/<name>/data/kuzu/`.
- [ ] Running init again in the same folder adds a second instance, doesn't overwrite the first.
- [ ] Running init in a folder with old layout errors clearly.
- [ ] `brainifai list` shows all instances across folders.
- [ ] `brainifai remove <name>` removes only that instance.
- [ ] LLM description generator produces sensible, <200-char descriptions for all 6 template types.
- [ ] Populate scripts for `coding`, `researcher`, `ehr`, `project-manager` invoke (even if they're stubs).
- [ ] SKILL.md generated contains instance namespaces and tool names correctly.
- [ ] `npm run test-connection` works against a project instance's DB.

## 6. Out of scope for this plan

- Hook installation (SessionStart/SessionEnd/UserPromptSubmit) — belongs to lifecycle plan.
- MCP server updates to expose per-instance namespaced tools — belongs to context-building plan.
- Graph schema for the `general` type beyond what `initializeInstanceDb` currently does — belongs to graph-management plan.
- Cross-instance cascade wiring — belongs to graph-management plan.
- Any ingestion changes.

## 7. Risks

- **Interactive prompts in non-TTY environments** (CI, scripts). Fall back to flag-driven init when `!process.stdin.isTTY`.
- **LLM description generation reliability.** Claude CLI may not be installed. Graceful fallback to mechanical generator + emit a warning.
- **Multi-instance resolution ambiguity.** When a folder has multiple instances and no name specified, we throw. Need clear error message pointing users to `--instance <name>` or `BRAINIFAI_INSTANCE_NAME` env.
- **Concurrent `brainifai init` calls** on the same folder. Use file lock on `<workdir>/.brainifai/.init.lock` to serialize.
- **Populate scripts that take long** — stream stdout to user, allow cancellation via SIGINT.

## 8. Estimated effort

- Phase 1: 1 day
- Phase 2: half day
- Phase 3: half day
- Phase 4: 1 day
- Phase 5: 1 day
- Phase 6: 1 day
- Phase 7: half day
- Phase 8: 1 day
- Phase 9: few hours

Total: ~6-7 working days.
