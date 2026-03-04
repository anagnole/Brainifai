import { z } from 'zod';
import { createHash } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KuzuGraphStore } from '../../graphstore/kuzu/adapter.js';
import { upsertBatch } from '../../ingestion/upsert.js';
import type { NormalizedMessage } from '../../shared/types.js';
import { MAX_SNIPPET_CHARS } from '../../shared/constants.js';
import { logger } from '../../shared/logger.js';

const MEMORY_KINDS = ['decision', 'insight', 'bug_fix', 'preference', 'session_summary'] as const;

export function registerIngestMemory(server: McpServer) {
  server.tool(
    'ingest_memory',
    'Save a knowledge snippet (decision, insight, bug fix, preference) into the knowledge graph for long-term recall',
    {
      snippet: z.string().min(1).max(5000)
        .describe('The knowledge to remember — a summary, decision, insight, or lesson learned'),
      topics: z.array(z.string()).min(1).max(10)
        .describe('Relevant topics (e.g. ["authentication", "react", "performance"])'),
      kind: z.enum(MEMORY_KINDS)
        .describe('Category of knowledge being saved'),
      project: z.string().optional()
        .describe('Project name (defaults to current working directory name)'),
    },
    async ({ snippet, topics, kind, project }) => {
      const now = new Date().toISOString();
      const contentHash = createHash('sha256').update(snippet).digest('hex').slice(0, 12);
      const timestamp = now.replace(/[:.]/g, '-');
      const sourceId = `claude-code:memory:${timestamp}:${contentHash}`;

      const userName = process.env.BRAINIFAI_USER_NAME ?? process.env.USER ?? 'unknown';
      const projectName = project ?? 'general';
      const personKey = `local:${userName}`;

      const truncatedSnippet = snippet.length > MAX_SNIPPET_CHARS
        ? snippet.slice(0, MAX_SNIPPET_CHARS) + '…'
        : snippet;

      const msg: NormalizedMessage = {
        activity: {
          source: 'claude-code',
          source_id: sourceId,
          timestamp: now,
          kind,
          snippet: truncatedSnippet,
          created_at: now,
          updated_at: now,
          valid_from: now,
        },
        person: {
          person_key: personKey,
          display_name: userName,
          source: 'local',
          source_id: userName,
        },
        container: {
          source: 'claude-code',
          container_id: `memory:${projectName}`,
          name: projectName,
          kind: 'project',
        },
        account: {
          source: 'local',
          account_id: `local:${userName}`,
          linked_person_key: personKey,
        },
        topics: topics.map((t) => ({ name: t.toLowerCase() })),
      };

      // Open a short-lived write store — Kuzu only allows one connection at a time,
      // so the MCP server must use on-demand mode (GRAPHSTORE_ON_DEMAND=true) for
      // this to work. The on-demand adapter releases the lock between calls.
      const dbPath = process.env.KUZU_DB_PATH ?? './data/kuzu';
      const store = new KuzuGraphStore({ dbPath, readOnly: false });
      try {
        await store.initialize();
        await upsertBatch(store, [msg]);
        logger.info({ sourceId, kind }, 'Ingested memory snippet');
      } finally {
        await store.close();
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Saved ${kind} to knowledge graph.\nTopics: ${topics.join(', ')}\nSource ID: ${sourceId}`,
        }],
      };
    },
  );
}
