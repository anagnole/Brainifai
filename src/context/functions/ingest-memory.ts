import { z } from 'zod';
import { createHash } from 'crypto';
import type { ContextFunction } from '../types.js';
import { KuzuGraphStore } from '../../graphstore/kuzu/adapter.js';
import { upsertBatch } from '../../ingestion/upsert.js';
import type { NormalizedMessage } from '../../shared/types.js';
import { MAX_SNIPPET_CHARS } from '../../shared/constants.js';
import { logger } from '../../shared/logger.js';
import { resolveInstanceDbPath } from '../../instance/resolve.js';
import { getChildrenCache } from '../../mcp/children-cache.js';

const MEMORY_KINDS = ['decision', 'insight', 'bug_fix', 'preference', 'session_summary'] as const;

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

    // Use the cached children list (queried at MCP startup, before GraphStore opened)
    const children = getChildrenCache();

    if (children && children.length > 0) {
      try {
        const { orchestrateSource } = await import('../../orchestrator/index.js');
        const result = await orchestrateSource('memory', [msg], children);
        logger.info({ sourceId, kind, routed: result.routedToChildren, global: result.routedToGlobal }, 'Memory routed via orchestrator');

        return {
          message: `Saved ${kind} via orchestrator.`,
          topics: topics.join(', '),
          sourceId,
          routedToChildren: result.routedToChildren,
          routedToGlobal: result.routedToGlobal,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: errMsg, sourceId }, 'Orchestrator failed — falling back to direct write');
        // Store error for fallback response
        (globalThis as any).__brainifai_orch_error = errMsg;
      }
    }

    // Fallback: write directly to current instance
    const cacheStatus = children === null ? 'null' : `${children.length} children`;
    const dbPath = resolveInstanceDbPath();
    const writeStore = new KuzuGraphStore({ dbPath, readOnly: false });
    try {
      await writeStore.initialize();
      await upsertBatch(writeStore, [msg]);
      logger.info({ sourceId, kind, dbPath, cacheStatus }, 'Ingested memory snippet directly');
    } finally {
      await writeStore.close();
    }

    return {
      message: `Saved ${kind} to knowledge graph (direct write, cache: ${cacheStatus}, db: ${dbPath}, orchErr: ${(globalThis as any).__brainifai_orch_error ?? 'none'}).`,
      topics: topics.join(', '),
      sourceId,
    };
  },
};
