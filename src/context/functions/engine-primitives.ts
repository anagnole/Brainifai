// ─── Engine-backed ContextFunction wrappers ─────────────────────────────────
// Exposes the graph-engine's 4 brain-inspired retrieval primitives as MCP
// tools. These ignore the legacy `store` param and resolve their own engine
// via the singleton keyed on the resolved instance's dbPath.

import { z } from 'zod';
import { resolve } from 'node:path';
import type { ContextFunction } from '../types.js';
import type { GraphEngineInstance } from '../../graph-engine/instance.js';
import { getEngine } from '../../graph-engine/singleton.js';
import { generalSpec } from '../../instances/general/schema.js';
import {
  working_memory,
  associate,
  recall_episode,
  consolidate,
} from '../../instances/general/functions.js';
import { resolveInstance } from '../../instance/resolve.js';
import { logger } from '../../shared/logger.js';

// ─── Engine resolution ──────────────────────────────────────────────────────

/**
 * Find the engine for the active instance. Prefers BRAINIFAI_ENGINE_DB env
 * (useful for viz + tests) else resolves the nearest folder's instance and
 * opens its DB. First call per process pays ~1-2s for Kuzu warm-up.
 */
async function getActiveEngine(): Promise<GraphEngineInstance> {
  if (process.env.BRAINIFAI_ENGINE_DB) {
    return getEngine(process.env.BRAINIFAI_ENGINE_DB, generalSpec);
  }
  const resolved = resolveInstance();
  const dbPath = resolve(resolved.dbPath);
  return getEngine(dbPath, generalSpec);
}

// ─── working_memory ─────────────────────────────────────────────────────────

export const workingMemoryFn: ContextFunction = {
  name: 'working_memory',
  description:
    'Return the most-recently-accessed memories as a short-term scratchpad. ' +
    'No cue — just "what was I working on." ' +
    'Use scope="here" to restrict to the current working directory.',
  schema: {
    scope: z.enum(['global', 'here']).optional()
      .describe('"global" (default) = last N across all projects; "here" = filter to current cwd'),
    limit: z.number().int().min(1).max(50).optional()
      .describe('Max items to return (default 15)'),
  },
  async execute(input) {
    const { scope, limit } = input as { scope?: 'global' | 'here'; limit?: number };
    const engine = await getActiveEngine();
    const atoms = await working_memory(engine, { scope, limit });
    return {
      count: atoms.length,
      atoms: atoms.map(formatAtom),
    };
  },
};

// ─── associate ──────────────────────────────────────────────────────────────

export const associateFn: ContextFunction = {
  name: 'associate',
  description:
    'Spreading activation from a cue. Finds memories semantically or structurally ' +
    'related to the cue via the entity graph. Supports paraphrases — "the book I was ' +
    'reading" can find "Thinking Fast and Slow". Use for "what do I know about X" ' +
    'or "does this remind me of anything."',
  schema: {
    cue: z.string().min(1).describe('Natural-language cue — keyword, phrase, or pasted content'),
    limit: z.number().int().min(1).max(30).optional()
      .describe('Max items to return (default 10)'),
  },
  async execute(input) {
    const { cue, limit } = input as { cue: string; limit?: number };
    const engine = await getActiveEngine();
    const hits = await associate(engine, { cue, limit });
    return {
      cue,
      count: hits.length,
      results: hits.map((h) => ({
        score: Number(h.score.toFixed(3)),
        matched_entities: h.matched_entities,
        ...formatAtom(h.atom),
      })),
    };
  },
};

// ─── recall_episode ─────────────────────────────────────────────────────────

export const recallEpisodeFn: ContextFunction = {
  name: 'recall_episode',
  description:
    'Episodic recall — filter memories by time, location (cwd), kind, or cue-based rerank. ' +
    'Use for "what happened last week" or "list all decisions in this project."',
  schema: {
    cue: z.string().optional().describe('Optional cue to rerank matching atoms'),
    from: z.string().optional().describe('ISO 8601 from-date inclusive (e.g. 2026-01-01)'),
    to: z.string().optional().describe('ISO 8601 to-date inclusive'),
    where: z.string().optional().describe('cwd to filter by (e.g. /Users/me/proj)'),
    kind: z.string().optional().describe('Atom kind filter (decision, insight, observation, ...)'),
    limit: z.number().int().min(1).max(50).optional().describe('Max items (default 20)'),
  },
  async execute(input) {
    const { cue, from, to, where, kind, limit } = input as {
      cue?: string; from?: string; to?: string;
      where?: string; kind?: string; limit?: number;
    };
    const engine = await getActiveEngine();
    const atoms = await recall_episode(engine, {
      cue, where, kind, limit,
      when: (from || to) ? { from, to } : undefined,
    });
    return {
      count: atoms.length,
      atoms: atoms.map(formatAtom),
    };
  },
};

// ─── consolidate ────────────────────────────────────────────────────────────

export const consolidateFn: ContextFunction = {
  name: 'consolidate',
  description:
    'Save a memory into the knowledge graph. Use for decisions, insights, bug-fix ' +
    'conclusions, preferences, or anything worth long-term recall. Supersedes accepts ' +
    'an atom id OR a natural-language cue ("the Neo4j decision") that we resolve via ' +
    'semantic similarity.',
  schema: {
    content: z.string().min(1).max(5000).describe('The knowledge to remember'),
    kind: z.string().optional().describe(
      'Category: decision | insight | observation | preference | bug-fix | conversation | correction. Default "observation".',
    ),
    salience: z.enum(['low', 'normal', 'high']).optional().describe('Default "normal"'),
    supersedes: z.union([z.string(), z.array(z.string())]).optional().describe(
      'Prior atom id(s) or a cue string. Links SUPERSEDES edges for corrections.',
    ),
  },
  async execute(input) {
    const { content, kind, salience, supersedes } = input as {
      content: string;
      kind?: string;
      salience?: 'low' | 'normal' | 'high';
      supersedes?: string | string[];
    };
    const engine = await getActiveEngine();
    try {
      const result = await consolidate(engine, { content, kind, salience, supersedes });
      return {
        ok: true,
        id: result.id,
        superseded: result.superseded,
        message: `Saved ${kind ?? 'observation'} (${result.id.slice(-8)}).` +
          (result.superseded.length > 0 ? ` Superseded ${result.superseded.length} prior atom(s).` : ''),
      };
    } catch (err) {
      logger.warn({ err }, 'consolidate failed');
      return { ok: false, error: (err as Error).message };
    }
  },
};

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatAtom(a: {
  id: string; content: string; kind: string; created_at: string;
  cwd: string | null; tier?: string; salience: string;
}): Record<string, unknown> {
  return {
    id: a.id,
    kind: a.kind,
    salience: a.salience,
    content: a.content,
    created_at: a.created_at,
    cwd: a.cwd ?? null,
    tier: a.tier ?? null,
  };
}
