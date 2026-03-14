import { logger } from '../shared/logger.js';
import type { NormalizedMessage } from '../shared/types.js';
import type { InstanceContext, ClassificationBatch, OrchestratorConfig } from './types.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';

const MAX_SNIPPET_CHARS = 500;

interface ClassifierResponse {
  index: number;
  targets: string[];
  confidence: number;
  reason: string;
}

function globalFallback(messages: NormalizedMessage[], reason: string): ClassificationBatch {
  return {
    results: messages.map(msg => ({
      message: msg,
      decision: { targets: [], confidence: 0, reason },
    })),
    errors: [],
  };
}

export async function classifyBatch(
  messages: NormalizedMessage[],
  instances: InstanceContext[],
  config: OrchestratorConfig,
): Promise<ClassificationBatch> {
  const validInstanceNames = new Set(instances.map(i => i.name));

  // Build compact representations for the prompt
  const batchItems = messages.map((msg, i) => ({
    index: i,
    source: msg.activity.source,
    kind: msg.activity.kind,
    snippet: msg.activity.snippet.slice(0, MAX_SNIPPET_CHARS),
    topics: msg.topics.map(t => t.name),
  }));

  const body = {
    model: config.model,
    max_tokens: 4096,
    system: buildSystemPrompt(instances),
    messages: [{ role: 'user' as const, content: buildUserPrompt(batchItems) }],
  };

  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logger.error({ err }, 'Classifier API request failed');
    return globalFallback(messages, 'API request error — global fallback');
  }

  if (!response.ok) {
    logger.error({ status: response.status }, 'Classifier API call failed');
    return globalFallback(messages, 'API failure — global fallback');
  }

  const data = await response.json() as { content: Array<{ type: string; text?: string }> };
  const text = data.content.find(b => b.type === 'text')?.text ?? '[]';

  // Parse JSON from response (handle markdown code blocks)
  const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  let decisions: ClassifierResponse[];
  try {
    decisions = JSON.parse(jsonStr);
  } catch {
    logger.error({ text }, 'Failed to parse classifier response');
    return globalFallback(messages, 'Parse failure — global fallback');
  }

  // Map decisions back to messages
  const results: ClassificationBatch['results'] = [];
  const decisionMap = new Map(decisions.map(d => [d.index, d]));

  for (let i = 0; i < messages.length; i++) {
    const d = decisionMap.get(i);
    if (!d) {
      results.push({
        message: messages[i],
        decision: { targets: [], confidence: 0, reason: 'Missing from classifier output' },
      });
      continue;
    }

    // Filter to valid instance names only
    const validTargets = d.targets.filter(t => validInstanceNames.has(t));

    results.push({
      message: messages[i],
      decision: {
        targets: d.confidence >= config.confidenceThreshold ? validTargets : [],
        confidence: d.confidence,
        reason: d.reason,
      },
    });
  }

  return { results, errors: [] };
}
