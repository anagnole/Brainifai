// ─── Shared LLM provider ────────────────────────────────────────────────────
// Singleton ClaudeCliProvider used by the engine, per-instance retrieval, and
// any caller that needs a one-shot LLM completion. Configured to use the local
// Claude CLI subscription (ANTHROPIC_API_KEY stripped on first init).

import { ClaudeCliProvider } from '@anagnole/claude-cli-wrapper';
import { logger } from '../shared/logger.js';

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// ─── Singleton provider ─────────────────────────────────────────────────────

let provider: ClaudeCliProvider | null = null;

/** Get the shared provider. Lazily initializes on first call. */
export function getProvider(): ClaudeCliProvider {
  if (!provider) {
    // Using the CLI subscription, not the API. Strip the env var so the
    // wrapper doesn't accidentally switch to API mode.
    delete process.env.ANTHROPIC_API_KEY;
    provider = new ClaudeCliProvider({ defaultModel: DEFAULT_MODEL });
  }
  return provider;
}

/** Reset the singleton — test hook only. Not exported from index.ts. */
export function _resetProviderForTesting(): void {
  provider = null;
}

// ─── Completion API ─────────────────────────────────────────────────────────

export interface CompleteOptions {
  /** Override default model. */
  model?: string;
  /** Max output tokens. Default 2048. */
  maxTokens?: number;
  /** Hard timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Max turns for tool use. Default 1. */
  maxTurns?: number;
}

/**
 * Run a single-prompt completion. Returns the concatenated text content.
 * Throws on timeout or wrapper error — callers choose their own fallback.
 */
export async function complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
  const cli = getProvider();
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const response = await withTimeout(
    cli.complete({
      model: opts.model ?? DEFAULT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: opts.maxTokens ?? 2048,
      max_turns: opts.maxTurns ?? 1,
    }),
    timeoutMs,
  );

  return extractText(response);
}

// ─── JSON extraction ────────────────────────────────────────────────────────

/**
 * Extract a JSON value from LLM output. Handles:
 *   - raw JSON ("{ ... }" or "[ ... ]")
 *   - markdown-fenced (```json ... ``` or ``` ... ```)
 *   - embedded JSON object/array within commentary
 * Throws if no parseable JSON is found.
 */
export function extractJson<T = unknown>(text: string): T {
  const trimmed = text.trim();

  // 1) Raw
  try { return JSON.parse(trimmed) as T; } catch { /* try next */ }

  // 2) Markdown fence
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) {
    try { return JSON.parse(fenced[1].trim()) as T; } catch { /* try next */ }
  }

  // 3) Embedded JSON — prefer whichever of '{' or '[' appears first, since
  //    that's the outermost container.
  const objStart = trimmed.indexOf('{');
  const objEnd = trimmed.lastIndexOf('}');
  const arrStart = trimmed.indexOf('[');
  const arrEnd = trimmed.lastIndexOf(']');

  const objValid = objStart >= 0 && objEnd > objStart;
  const arrValid = arrStart >= 0 && arrEnd > arrStart;

  const arrFirst = arrValid && (!objValid || arrStart < objStart);
  const objFirst = objValid && (!arrValid || objStart < arrStart);

  if (arrFirst) {
    try { return JSON.parse(trimmed.slice(arrStart, arrEnd + 1)) as T; } catch { /* try obj as fallback */ }
  }
  if (objFirst || objValid) {
    try { return JSON.parse(trimmed.slice(objStart, objEnd + 1)) as T; } catch { /* fall through */ }
  }
  if (arrValid && !arrFirst) {
    try { return JSON.parse(trimmed.slice(arrStart, arrEnd + 1)) as T; } catch { /* fall through */ }
  }

  throw new Error('No valid JSON found in LLM response');
}

/**
 * Try to extract JSON; fall back to `fallback` on failure. Logs the failure
 * but doesn't propagate — for best-effort extraction paths.
 */
export function extractJsonOr<T>(text: string, fallback: T): T {
  try { return extractJson<T>(text); } catch (err) {
    logger.warn({ err: (err as Error).message, preview: text.slice(0, 200) }, 'extractJson failed');
    return fallback;
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

interface MinimalCliResponse {
  content: Array<{ type?: string; text?: string }>;
}

function extractText(response: unknown): string {
  const r = response as MinimalCliResponse;
  return r.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('\n')
    .trim();
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`LLM call timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
