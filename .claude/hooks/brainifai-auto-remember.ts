#!/usr/bin/env tsx
/**
 * PostToolUse hook — fires after `git commit` (Bash tool).
 *
 * Reads the commit message and diff stats, then instructs Claude
 * to call ingest_memory with a summary of the committed work.
 *
 * This replaces the need for manual `/remember` — every meaningful
 * commit automatically becomes a knowledge graph entry.
 */

// Disable via env var
if (process.env.BRAINIFAI_HOOKS === 'false') process.exit(0);

import { readFileSync } from 'node:fs';

interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
}

let raw = '';
try {
  raw = readFileSync('/dev/stdin', 'utf-8').trim();
} catch {
  process.exit(0);
}

if (!raw) process.exit(0);

let input: HookInput;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

// Only trigger on Bash tool
if (input.tool_name !== 'Bash') process.exit(0);

const command = String(input.tool_input?.command ?? '');
const result = typeof input.tool_response === 'string'
  ? input.tool_response
  : JSON.stringify(input.tool_response ?? '');

// Only trigger on successful git commit (not amend, not revert, not merge)
const isCommit = /\bgit\s+commit\b/.test(command) && !command.includes('--amend');
if (!isCommit) process.exit(0);

// Check the result looks like a successful commit (has the [branch hash] pattern)
const commitMatch = result.match(/\[(\S+)\s+([a-f0-9]+)\]/);
if (!commitMatch) process.exit(0);

const branch = commitMatch[1];
const shortHash = commitMatch[2];

// Extract commit message from the result
const msgMatch = result.match(/\]\s+(.+?)(?:\n|$)/);
const commitMsg = msgMatch ? msgMatch[1].trim() : 'unknown';

// Count files changed
const filesMatch = result.match(/(\d+)\s+files?\s+changed/);
const filesChanged = filesMatch ? filesMatch[1] : '?';

// Build the instruction for Claude
const context = `[Brainifai] Auto-remember: You just committed "${commitMsg}" (${shortHash} on ${branch}, ${filesChanged} files changed). Call the \`consolidate\` MCP tool to save this to the knowledge graph. Pass a concise summary as \`content\` (focus on the "what" and "why", not the step-by-step). Set \`kind\` to "decision" for an architectural choice, "bug-fix" if it fixed a bug, or "insight" for other notable work. Set \`salience\` to "high" if this is a meaningful change, otherwise omit it.`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: context,
    },
  }),
);
