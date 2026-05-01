// ─── Engine SessionStart hook ──────────────────────────────────────────────
// Injects short-term memory (working_memory tail from the engine's general
// graph) into Claude Code's SessionStart context. Separate from the legacy
// brainifai-session-start.ts hook — the two coexist; both can write
// additional context and Claude Code stacks them.
//
// The legacy hook queries Person/Activity/Topic (old schema) from whichever
// .brainifai/ instance is nearest. This hook queries Atom/Entity/Episode
// (new engine schema) from ~/.brainifai/global/data/kuzu (or
// $BRAINIFAI_ENGINE_DB if set).
//
// Emits JSON to stdout in Claude Code's expected format.

if (process.env.BRAINIFAI_HOOKS === 'false') process.exit(0);

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { getEngine, closeEngine } from '../../src/graph-engine/singleton.js';
import { generalSpec } from '../../src/instances/general/schema.js';
import { working_memory } from '../../src/instances/general/functions.js';

const HOOK_BUDGET = 2500;
const WM_LIMIT = 8;

function emit(context: string): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }),
  );
  process.exit(0);
}

function truncate(text: string, budget: number): string {
  return text.length <= budget ? text : text.slice(0, budget - 3) + '...';
}

function formatAtom(a: { kind: string; content: string; created_at: string; cwd: string | null }): string {
  const day = a.created_at.slice(0, 10);
  const cwd = a.cwd ? ` [${a.cwd.split('/').pop()}]` : '';
  const content = a.content.length > 150 ? a.content.slice(0, 147) + '...' : a.content;
  return `- [${day}] [${a.kind}]${cwd} ${content}`;
}

async function main() {
  const dbPath = process.env.BRAINIFAI_ENGINE_DB
    ?? resolve(homedir(), '.brainifai', 'global', 'data', 'kuzu');

  // Engine DB may not exist yet (user hasn't run init) — bail silently.
  if (!existsSync(dbPath)) process.exit(0);

  let engine;
  try {
    engine = await getEngine(dbPath, generalSpec);
  } catch {
    process.exit(0);
  }

  try {
    // Pull two slices: current-cwd memories (if any) + global recent.
    const cwd = process.env.CLAUDE_PROJECT_DIR;

    const [local, global] = await Promise.all([
      cwd ? working_memory(engine, { scope: 'here', cwd, limit: WM_LIMIT }) : Promise.resolve([]),
      working_memory(engine, { scope: 'global', limit: WM_LIMIT }),
    ]);

    // Dedupe global list against local so we don't show the same atom twice.
    const localIds = new Set(local.map((a) => a.id));
    const globalOnly = global.filter((a) => !localIds.has(a.id));

    if (local.length === 0 && globalOnly.length === 0) {
      // Nothing to say — don't emit anything so we don't bloat Claude's context.
      process.exit(0);
    }

    const sections: string[] = ['## Brainifai working memory'];

    if (local.length > 0) {
      sections.push('', `### Recent here (${cwd})`);
      sections.push(...local.map(formatAtom));
    }

    if (globalOnly.length > 0) {
      sections.push('', '### Recent globally');
      sections.push(...globalOnly.slice(0, WM_LIMIT).map(formatAtom));
    }

    emit(truncate(sections.join('\n'), HOOK_BUDGET));
  } finally {
    await closeEngine(engine.dbPath).catch(() => { /* ignore */ });
  }
}

main().catch(() => process.exit(0));
