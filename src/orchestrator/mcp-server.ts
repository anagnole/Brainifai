/**
 * Orchestrator MCP server — exposes push_to_instance and mark_as_global tools.
 * Spawned as a subprocess by the orchestrator Claude CLI process.
 *
 * Env vars (set by spawn.ts):
 *   BRAINIFAI_INSTANCE_REGISTRY — JSON array of { name, path }
 *   BRAINIFAI_BATCH_FILE        — path to temp JSON file with NormalizedMessage[]
 *   BRAINIFAI_GLOBAL_INDICES_FILE — path to write global indices (main process reads this)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KuzuGraphStore } from '../graphstore/kuzu/adapter.js';
import { upsertBatch } from '../ingestion/upsert.js';
import { pushRecentActivity } from '../instance/resolve.js';
import type { NormalizedMessage } from '../shared/types.js';

// ─── Parse env config ────────────────────────────────────────────────────────

interface RegistryEntry {
  name: string;
  path: string;
}

const registry: Map<string, RegistryEntry> = new Map();
try {
  const entries: RegistryEntry[] = JSON.parse(process.env.BRAINIFAI_INSTANCE_REGISTRY ?? '[]');
  for (const e of entries) registry.set(e.name, e);
} catch {
  console.error('Failed to parse BRAINIFAI_INSTANCE_REGISTRY');
  process.exit(1);
}

const batchFile = process.env.BRAINIFAI_BATCH_FILE;
if (!batchFile) {
  console.error('BRAINIFAI_BATCH_FILE not set');
  process.exit(1);
}

const globalIndicesFile = process.env.BRAINIFAI_GLOBAL_INDICES_FILE;
if (!globalIndicesFile) {
  console.error('BRAINIFAI_GLOBAL_INDICES_FILE not set');
  process.exit(1);
}

// ─── Lazy-load batch from file ───────────────────────────────────────────────

let cachedBatch: NormalizedMessage[] | null = null;

function loadBatch(): NormalizedMessage[] {
  if (!cachedBatch) {
    cachedBatch = JSON.parse(readFileSync(batchFile!, 'utf-8'));
  }
  return cachedBatch!;
}

// ─── Track global indices ────────────────────────────────────────────────────

const globalIndices: Set<number> = new Set();

function persistGlobalIndices() {
  writeFileSync(globalIndicesFile!, JSON.stringify([...globalIndices]));
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'orchestrator',
  version: '0.1.0',
});

server.tool(
  'push_to_instance',
  'Route messages to a child instance by writing them to its Kuzu database',
  {
    instance_name: z.string().describe('Target instance name from the instance tree'),
    message_indices: z.array(z.number().int().min(0))
      .describe('Indices of messages in the batch file to push to this instance'),
  },
  async ({ instance_name, message_indices }) => {
    const entry = registry.get(instance_name);
    if (!entry) {
      return {
        content: [{ type: 'text' as const, text: `Error: instance "${instance_name}" not found in registry` }],
        isError: true,
      };
    }

    const batch = loadBatch();
    const messages = message_indices
      .filter(i => i >= 0 && i < batch.length)
      .map(i => batch[i]);

    if (messages.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No valid messages for the given indices' }],
        isError: true,
      };
    }

    const dbPath = resolve(entry.path, 'data', 'kuzu');
    const store = new KuzuGraphStore({ dbPath, readOnly: false });
    try {
      await store.initialize();
      await upsertBatch(store, messages);
    } finally {
      await store.close();
    }

    // Update instance's recent activities (FIFO, max 5)
    try {
      const last = messages[messages.length - 1];
      pushRecentActivity(entry.path, {
        timestamp: last.activity.timestamp,
        kind: last.activity.kind,
        snippet: last.activity.snippet.slice(0, 100),
        topics: last.topics?.map(t => t.name) ?? [],
      });
    } catch { /* best effort */ }

    return {
      content: [{ type: 'text' as const, text: `Pushed ${messages.length} messages to "${instance_name}"` }],
    };
  },
);

server.tool(
  'mark_as_global',
  'Mark messages as belonging to the global instance. The main process will handle writing them.',
  {
    message_indices: z.array(z.number().int().min(0))
      .describe('Indices of messages in the batch file that should go to global'),
  },
  async ({ message_indices }) => {
    const batch = loadBatch();
    const valid = message_indices.filter(i => i >= 0 && i < batch.length);

    for (const i of valid) globalIndices.add(i);
    persistGlobalIndices();

    return {
      content: [{ type: 'text' as const, text: `Marked ${valid.length} messages for global (${globalIndices.size} total)` }],
    };
  },
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
