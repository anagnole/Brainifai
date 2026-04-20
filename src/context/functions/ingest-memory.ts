import { z } from 'zod';
import { createHash } from 'crypto';
import type { ContextFunction } from '../types.js';
import { KuzuGraphStore } from '../../graphstore/kuzu/adapter.js';
import { upsertBatch } from '../../ingestion/upsert.js';
import type { NormalizedMessage } from '../../shared/types.js';
import { MAX_SNIPPET_CHARS } from '../../shared/constants.js';
import { logger } from '../../shared/logger.js';
import { resolveInstanceDbPath } from '../../instance/resolve.js';

const MEMORY_KINDS = ['decision', 'insight', 'bug_fix', 'preference', 'session_summary'] as const;

/**
 * MCP tool: save a knowledge snippet to the current instance's graph.
 * With the cascade model (no central orchestrator), this just writes to the
 * nearest instance. Cross-instance propagation to global will be handled by
 * a separate cascade step once wired.
 */
export const ingestMemoryFn: ContextFunction = {
  name: 'ingest_memory',
  description: 'Save a knowledge snippet (decision, insight, bug fix, preference) into the knowledge graph for long-term recall',
  schema: {
    snippet: z.string().min(1).max(5000)
      .describe('The knowledge to remember — a summary, decision, insight, or lesson learned'),
    topics: z.array(z.string()).min(1).max(10)
      .describe('Relevant topics (e.g. ["authentication", "react", "performance"])'),
    kind: z.enum(MEMORY_KINDS)
      .describe('Category of knowledge being saved'),
    project: z.string().optional()
      .describe('Project name (defaults to current working directory name)'),
  },
  async execute(input, _store) {
    const { snippet, topics, kind, project } = input as {
      snippet: string; topics: string[]; kind: typeof MEMORY_KINDS[number]; project?: string;
    };

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

    const dbPath = resolveInstanceDbPath();
    const writeStore = new KuzuGraphStore({ dbPath, readOnly: false });
    try {
      await writeStore.initialize();
      await upsertBatch(writeStore, [msg]);
      logger.info({ sourceId, kind, dbPath }, 'Ingested memory snippet');
    } finally {
      await writeStore.close();
    }

    return {
      message: `Saved ${kind} to knowledge graph.`,
      topics: topics.join(', '),
      sourceId,
    };
  },
};
