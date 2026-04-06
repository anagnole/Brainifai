/**
 * LLM extraction layer for researcher instances.
 *
 * Takes ingested activities, sends them to Claude via @anagnole/claude-cli-wrapper
 * for entity/event/relationship extraction, and returns structured ExtractionResult.
 */

import { ClaudeCliProvider } from '@anagnole/claude-cli-wrapper';
import { logger } from '../../shared/logger.js';
import type { NormalizedMessage } from '../../shared/types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExtractionResult {
  entities: Array<{
    name: string;
    type: string;
    description?: string;
    url?: string;
  }>;
  events: Array<{
    title: string;
    date: string;
    description: string;
    significance: string;
    event_type: string;
    involved_entities: Array<{ name: string; role: string }>;
  }>;
  relationships: Array<{
    from_entity: string;
    to_entity: string;
    relation_type: string;
  }>;
  trends: Array<{
    name: string;
    linked_events: string[];
  }>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const EXTRACTION_BATCH_SIZE = 20;

// ─── Fallback ────────────────────────────────────────────────────────────────

export function fallbackExtraction(): ExtractionResult {
  return { entities: [], events: [], relationships: [], trends: [] };
}

// ─── Provider singleton ─────────────────────────────────────────────────────

let provider: ClaudeCliProvider | null = null;

function getProvider(): ClaudeCliProvider {
  if (!provider) {
    // Strip ANTHROPIC_API_KEY so Claude CLI uses the subscription, not the API
    delete process.env.ANTHROPIC_API_KEY;
    provider = new ClaudeCliProvider({ defaultModel: 'claude-haiku-4-5-20251001' });
  }
  return provider;
}

// ─── Main extraction ─────────────────────────────────────────────────────────

function buildPrompt(snippets: string, domain: string): string {
  return `You are analyzing content about ${domain}. Extract factual, structured knowledge from the following activities.

Activities:
${snippets}

Extract ONLY factual information. Skip pure opinions, engagement bait, or speculative commentary.

Return a JSON object with this exact structure (no markdown fencing, no explanation — just raw JSON):
{
  "entities": [
    { "name": "...", "type": "company|product|person|project|organization|technology|framework", "description": "one sentence", "url": "optional url" }
  ],
  "events": [
    { "title": "short title", "date": "YYYY-MM-DD", "description": "what happened", "significance": "high|medium|low", "event_type": "release|acquisition|partnership|funding|controversy|regulation|research|milestone", "involved_entities": [{ "name": "...", "role": "subject|partner|target|investor|regulator" }] }
  ],
  "relationships": [
    { "from_entity": "...", "to_entity": "...", "relation_type": "competitor|subsidiary|partner|fork_of|acquired_by|invested_in|built_by|depends_on" }
  ],
  "trends": [
    { "name": "...", "linked_events": ["event title 1", "event title 2"] }
  ]
}

If no entities/events/relationships/trends can be reliably extracted, return empty arrays.`;
}

/**
 * Extract structured knowledge from a batch of activities using Claude CLI wrapper.
 * On any error, returns an empty ExtractionResult.
 */
export async function extractFromBatch(
  activities: NormalizedMessage[],
  domain: string,
): Promise<ExtractionResult> {
  if (activities.length === 0) return fallbackExtraction();

  const snippets = activities
    .map((a, i) => {
      const src = a.activity.source_id;
      const ts = a.activity.timestamp;
      const text = a.activity.snippet;
      return `[${i + 1}] source_id=${src}  timestamp=${ts}\n${text}`;
    })
    .join('\n\n---\n\n');

  const prompt = buildPrompt(snippets, domain);

  try {
    const cli = getProvider();
    const response = await cli.complete({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
      max_turns: 1,
    });

    const text = response.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n');

    // Parse JSON from the response (handle optional markdown fencing)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('Extraction response did not contain valid JSON');
      return fallbackExtraction();
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<ExtractionResult>;

    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
      trends: Array.isArray(parsed.trends) ? parsed.trends : [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, 'Extraction failed — using fallback');
    console.error(`[extraction] Batch failed: ${msg}`);
    return fallbackExtraction();
  }
}
