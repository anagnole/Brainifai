// ─── Description Auto-Refinement ─────────────────────────────────────────────
// Periodically updates an instance's description to reflect what it actually
// contains. Uses the shared graph-engine LLM provider (Claude Haiku).

import type { GraphStore } from '../graphstore/types.js';
import { complete } from '../graph-engine/llm.js';
import { logger } from '../shared/logger.js';

const MAX_DESCRIPTION_CHARS = 200;
const CLI_TIMEOUT_MS = 30_000;

export interface RefinementInput {
  currentDescription: string;
  instanceName: string;
  instanceType: string;
  recentTopics: string[];       // top topics by activity count
  recentSources: string[];      // which sources have data
  entityCount: number;
  activityCount: number;
}

/**
 * Gather refinement inputs from the instance's graph store.
 */
export async function gatherRefinementContext(
  store: GraphStore,
): Promise<Omit<RefinementInput, 'currentDescription' | 'instanceName' | 'instanceType'>> {
  const topicResults = await store.search({ query: '*', types: ['Topic'], limit: 20 });
  const recentTopics = topicResults.map((r) => r.name);

  const recentActivities = await store.getRecentActivity({
    since: new Date(Date.now() - 30 * 86400 * 1000).toISOString(),
    limit: 50,
  });
  const sourceSet = new Set<string>();
  for (const a of recentActivities) sourceSet.add(a.source);

  return {
    recentTopics,
    recentSources: [...sourceSet],
    entityCount: topicResults.length,
    activityCount: recentActivities.length,
  };
}

/**
 * Generate a refined description based on what the instance actually contains.
 */
export async function generateRefinedDescription(input: RefinementInput): Promise<string> {
  const prompt = buildPrompt(input);

  try {
    const text = await complete(prompt, { maxTokens: 256, timeoutMs: CLI_TIMEOUT_MS });
    if (!text) throw new Error('Empty response from Claude CLI');

    const cleaned = text
      .replace(/^["`'\s]+|["`'\s]+$/g, '')
      .trim()
      .slice(0, MAX_DESCRIPTION_CHARS);

    logger.info({ instance: input.instanceName, description: cleaned }, 'Generated refined description');
    return cleaned;
  } catch (err) {
    logger.error({ err, instance: input.instanceName }, 'Refinement failed');
    throw new Error(`Refinement failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildPrompt(input: RefinementInput): string {
  return `You are refining a Brainifai instance description. The description is used by an orchestrator to route data to the correct instance, so it must be specific and accurate.

Current instance:
- Name: ${input.instanceName}
- Type: ${input.instanceType}
- Current description: ${input.currentDescription}

Data summary:
- Topics: ${input.recentTopics.slice(0, 15).join(', ') || 'none yet'}
- Sources: ${input.recentSources.join(', ') || 'none yet'}
- Entity count: ${input.entityCount}
- Activity count: ${input.activityCount}

Write a refined 1-2 sentence description (max ${MAX_DESCRIPTION_CHARS} chars) that captures what this instance actually contains based on the data. Keep it specific enough for routing. If the current description is already accurate, return it unchanged.

Return ONLY the description text, nothing else.`;
}
