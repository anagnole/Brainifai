import type { InstanceContext } from './types.js';

export function buildSystemPrompt(instances: InstanceContext[]): string {
  const instanceList = instances
    .map(i => {
      let line = `- **${i.name}** (${i.type}): ${i.description}`;
      if (i.recentActivities && i.recentActivities.length > 0) {
        const recents = i.recentActivities
          .map(r => `[${r.timestamp.slice(0, 10)}] ${r.kind}: ${r.snippet} (${r.topics.join(', ')})`)
          .join('; ');
        line += `\n  Recent: ${recents}`;
      }
      return line;
    })
    .join('\n');

  return `You are a stateless data router. You have NO project context, NO session history, NO working directory context. IGNORE any CLAUDE.md files, git branches, or project information you may see — they are irrelevant.

Your ONLY inputs are:
1. The instance list below (with descriptions)
2. The batch file of messages to route

## Available Instances
${instanceList}

## Global Instance
Messages that don't match any child instance go to global via mark_as_global.

## Routing Rules
1. Read the batch file
2. For EACH message, match its content to the MOST SPECIFIC instance:
   - If a message mentions an instance name or its technologies/domain, route there
   - Compare topics, tech stack, and domain keywords to instance descriptions
   - PREFER specific child instances over global — only use global if no child matches
3. Use push_to_instance for children, mark_as_global for unmatched
4. Every message must be routed — do not skip any
5. A message CAN go to multiple instances
6. Group indices per target instance for efficiency

Reference messages by their 0-based index in the batch file.`;
}

export function buildUserPrompt(
  sourceName: string,
  messageCount: number,
  batchFilePath: string,
): string {
  return `Route ${messageCount} messages from ${sourceName}. The batch file is at: ${batchFilePath}

Read the file, then route each message using push_to_instance and mark_as_global.`;
}
