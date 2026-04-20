// ─── Description generation ─────────────────────────────────────────────────
// LLM-generated descriptions via the shared graph-engine LLM provider.
// Falls back to a mechanical concat when the CLI is unavailable or times out.

import type { SourceSubscription } from './types.js';
import { complete } from '../graph-engine/llm.js';
import { logger } from '../shared/logger.js';

const MAX_DESCRIPTION_CHARS = 200;
const CLI_TIMEOUT_MS = 30_000;

// ─── Public API ─────────────────────────────────────────────────────────────

export interface GenerateDescriptionInput {
  name: string;
  type: string;
  workdir: string;
  sources: SourceSubscription[];
  domain?: string;
}

/**
 * Generate a 1-2 sentence description for a new instance.
 * Uses Claude Haiku via the shared provider; falls back to mechanical on failure.
 */
export async function generateDescription(input: GenerateDescriptionInput): Promise<string> {
  try {
    return await generateViaLlm(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg, name: input.name }, 'LLM description failed, using fallback');
    return mechanicalDescription(input);
  }
}

/** Always use the mechanical generator — useful for tests and non-TTY contexts. */
export function mechanicalDescription(input: GenerateDescriptionInput): string {
  const enabled = input.sources
    .filter((s) => s.enabled)
    .map((s) => s.source)
    .join(', ');

  const typeLabel = {
    coding: 'Coding project',
    manager: 'Management',
    general: 'General-purpose',
    'project-manager': 'Project Manager',
    researcher: 'Research',
    ehr: 'Clinical EHR',
  }[input.type] ?? `Custom (${input.type})`;

  const base = `${typeLabel} instance for ${input.name}, subscribed to ${enabled || 'no sources'}.`;
  return base.slice(0, MAX_DESCRIPTION_CHARS);
}

// ─── LLM path ───────────────────────────────────────────────────────────────

async function generateViaLlm(input: GenerateDescriptionInput): Promise<string> {
  const prompt = buildPrompt(input);
  const text = await complete(prompt, { maxTokens: 256, timeoutMs: CLI_TIMEOUT_MS });

  if (!text) throw new Error('Empty response from Claude CLI');

  // Strip markdown fencing / quoting an overly helpful model might add
  const cleaned = text
    .replace(/^["`'\s]+|["`'\s]+$/g, '')
    .replace(/^description\s*[:=]\s*/i, '')
    .trim();

  return cleaned.slice(0, MAX_DESCRIPTION_CHARS);
}

function buildPrompt(input: GenerateDescriptionInput): string {
  const enabled = input.sources
    .filter((s) => s.enabled)
    .map((s) => s.source)
    .join(', ');

  return `Generate a 1-2 sentence description (max ${MAX_DESCRIPTION_CHARS} chars) for a Brainifai instance.

The description is used by an orchestrator to route data to the correct instance, so it must be specific and accurate — not generic.

Instance:
  name:    ${input.name}
  type:    ${input.type}
  workdir: ${input.workdir}
  sources: ${enabled || 'none'}${input.domain ? `\n  domain:  ${input.domain}` : ''}

Return ONLY the description text. No quotes, no prefix, no explanation.`;
}
