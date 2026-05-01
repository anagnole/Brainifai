// Bail fast if disabled
if (process.env.BRAINIFAI_HOOKS === 'false') process.exit(0);

// Force read-only on-demand mode for the graph store
process.env.GRAPHSTORE_ON_DEMAND = 'true';
process.env.GRAPHSTORE_READONLY = 'true';

// Let resolveInstanceDbPath() walk up from cwd to find the nearest instance
// No KUZU_DB_PATH override — resolution is automatic

import { enrichToolCall } from '../../src/hooks/enricher.js';

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());

  const { tool_name, tool_input } = input;

  try {
    const context = await enrichToolCall(tool_name, tool_input);
    if (!context) process.exit(0);

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: context,
        },
      }),
    );
    process.exit(0);
  } catch {
    // Never block the tool — exit 0 on any error
    process.exit(0);
  }
}

main();
