// ─── Description Auto-Refinement ─────────────────────────────────────────────

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GraphStore } from '../graphstore/types.js';
import { logger } from '../shared/logger.js';

const execFileAsync = promisify(execFile);

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
  // Get top topics by searching broadly
  const topicResults = await store.search({ query: '*', types: ['Topic'], limit: 20 });
  const recentTopics = topicResults.map((r) => r.name);

  // Get source distribution from recent activities
  const recentActivities = await store.getRecentActivity({ since: new Date(Date.now() - 30 * 86400 * 1000).toISOString(), limit: 50 });
  const sourceSet = new Set<string>();
  for (const a of recentActivities) {
    sourceSet.add(a.source);
  }

  return {
    recentTopics,
    recentSources: [...sourceSet],
    entityCount: topicResults.length,
    activityCount: recentActivities.length,
  };
}

/**
 * Generate a refined description based on what the instance actually contains.
 * Spawns the Claude CLI process (uses `claude` command with --print for non-interactive).
 */
export async function generateRefinedDescription(
  input: RefinementInput,
): Promise<string> {
  const prompt = `You are refining a Brainifai instance description. The description is used by an orchestrator to route data to the correct instance, so it must be specific and accurate.

Current instance:
- Name: ${input.instanceName}
- Type: ${input.instanceType}
- Current description: ${input.currentDescription}

Data summary:
- Topics: ${input.recentTopics.slice(0, 15).join(', ') || 'none yet'}
- Sources: ${input.recentSources.join(', ') || 'none yet'}
- Entity count: ${input.entityCount}
- Activity count: ${input.activityCount}

Write a refined 1-2 sentence description (max 200 chars) that captures what this instance actually contains based on the data. Keep it specific enough for routing. If the current description is already accurate, return it unchanged.

Return ONLY the description text, nothing else.`;

  try {
    const { stdout } = await execFileAsync('claude', [
      '--print',
      '--model', 'haiku',
      prompt,
    ], {
      timeout: 30_000,
      env: { ...process.env },
    });

    const text = stdout.trim();
    if (!text) {
      throw new Error('Empty response from Claude CLI');
    }

    // Enforce max length
    const description = text.slice(0, 200);
    logger.info({ instance: input.instanceName, description }, 'Generated refined description');
    return description;
  } catch (err) {
    logger.error({ err, instance: input.instanceName }, 'Claude CLI refinement failed');
    throw new Error(`Claude CLI refinement failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
