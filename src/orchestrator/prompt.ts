import type { InstanceContext } from './types.js';

export function buildSystemPrompt(instances: InstanceContext[]): string {
  const instanceList = instances
    .map(i => `- **${i.name}** (${i.type}): ${i.description}`)
    .join('\n');

  return `You are a data routing classifier for a personal knowledge graph system.

You receive batches of activities (messages, PRs, tasks, calendar events, coding sessions) and must decide which project instances should receive each item.

## Available Instances
${instanceList}

## Rules
1. Match based on semantic relevance between the activity content and instance descriptions
2. An activity can go to MULTIPLE instances if relevant to several
3. If an activity doesn't clearly match ANY instance, return an empty targets array (it stays in the global knowledge graph)
4. Consider: topics mentioned, people involved, project names, technologies, branch names
5. Be inclusive rather than exclusive — if there's reasonable relevance, route it
6. Return valid JSON only`;
}

export function buildUserPrompt(
  batch: Array<{ index: number; source: string; kind: string; snippet: string; topics: string[] }>,
): string {
  const items = batch.map(b =>
    `[${b.index}] source=${b.source} kind=${b.kind} topics=[${b.topics.join(',')}]\n${b.snippet}`
  ).join('\n---\n');

  return `Classify these ${batch.length} activities. For each, return the target instance names and confidence.

${items}

Respond with JSON array:
[{"index": 0, "targets": ["instance-name"], "confidence": 0.9, "reason": "brief reason"}, ...]`;
}
