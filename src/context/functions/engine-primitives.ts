// ─── Engine-backed ContextFunction wrappers ─────────────────────────────────
// Exposes the graph-engine's 4 brain-inspired retrieval primitives as MCP
// tools. Dual-mode execution:
//
//   - Leader (this process owns the Kuzu writer + the embedded HTTP API on
//     port 4200): tool calls run locally via `*_local` helpers.
//   - Follower (another MCP on this machine is the leader): tool calls
//     forward to the leader over HTTP. Failover: if the HTTP call fails
//     with a connection error, we attempt to promote ourselves and retry.
//
// The HTTP routes (src/api/routes/engine.ts) on the leader call the same
// `*_local` helpers, so leader and follower return identical shapes.

import { z } from 'zod';
import { resolve } from 'node:path';
import type { ContextFunction } from '../types.js';
import type { GraphEngineInstance } from '../../graph-engine/instance.js';
import { getEngine, ensureWorker } from '../../graph-engine/singleton.js';
import { generalSpec } from '../../instances/general/schema.js';
import {
  working_memory,
  associate,
  recall_episode,
  consolidate,
} from '../../instances/general/functions.js';
import { resolveInstance } from '../../instance/resolve.js';
import { logger } from '../../shared/logger.js';
import { getRole, getLeaderUrl, tryPromoteToLeader } from '../../shared/role.js';

// ─── Engine resolution (leader only) ────────────────────────────────────────

/**
 * Find the engine for the active instance. Prefers BRAINIFAI_ENGINE_DB env
 * (useful for viz + tests) else resolves the nearest folder's instance and
 * opens its DB. First call per process pays ~1-2s for Kuzu warm-up.
 *
 * Only callable in leader mode — followers forward via HTTP and never
 * touch Kuzu directly.
 */
async function getActiveEngine(): Promise<GraphEngineInstance> {
  const dbPath = process.env.BRAINIFAI_ENGINE_DB
    ?? resolve(resolveInstance().dbPath);
  const engine = await getEngine(dbPath, generalSpec);
  ensureWorker(engine, { emptyPollMs: 1500 });
  return engine;
}

// ─── Local executors (run on the leader) ────────────────────────────────────

interface WorkingMemoryInput { scope?: 'global' | 'here'; limit?: number }
interface AssociateInput { cue: string; limit?: number }
interface RecallEpisodeInput {
  cue?: string; from?: string; to?: string;
  where?: string; kind?: string; limit?: number;
}
interface ConsolidateInput {
  content: string;
  kind?: string;
  salience?: 'low' | 'normal' | 'high';
  supersedes?: string | string[];
}

export async function workingMemoryLocal(input: WorkingMemoryInput) {
  const engine = await getActiveEngine();
  const atoms = await working_memory(engine, { scope: input.scope, limit: input.limit });
  return { count: atoms.length, atoms: atoms.map(formatAtom) };
}

export async function associateLocal(input: AssociateInput) {
  const engine = await getActiveEngine();
  const hits = await associate(engine, { cue: input.cue, limit: input.limit });
  return {
    cue: input.cue,
    count: hits.length,
    results: hits.map((h) => ({
      score: Number(h.score.toFixed(3)),
      matched_entities: h.matched_entities,
      ...formatAtom(h.atom),
    })),
  };
}

export async function recallEpisodeLocal(input: RecallEpisodeInput) {
  const engine = await getActiveEngine();
  const atoms = await recall_episode(engine, {
    cue: input.cue,
    where: input.where,
    kind: input.kind,
    limit: input.limit,
    when: (input.from || input.to) ? { from: input.from, to: input.to } : undefined,
  });
  return { count: atoms.length, atoms: atoms.map(formatAtom) };
}

export async function consolidateLocal(input: ConsolidateInput) {
  const engine = await getActiveEngine();
  try {
    const result = await consolidate(engine, {
      content: input.content,
      kind: input.kind,
      salience: input.salience,
      supersedes: input.supersedes,
    });
    return {
      ok: true,
      id: result.id,
      superseded: result.superseded,
      message: `Saved ${input.kind ?? 'observation'} (${result.id.slice(-8)}).` +
        (result.superseded.length > 0 ? ` Superseded ${result.superseded.length} prior atom(s).` : ''),
    };
  } catch (err) {
    logger.warn({ err }, 'consolidate failed');
    return { ok: false, error: (err as Error).message };
  }
}

// ─── Forwarder (run on followers) ───────────────────────────────────────────

/**
 * POST `input` to the leader's `/api/engine/<endpoint>`. On connection
 * error, attempt promotion to leader and signal the caller to fall through
 * to the local path. On HTTP error from a still-alive leader, propagate.
 */
async function forwardToLeader<T>(
  endpoint: 'working_memory' | 'associate' | 'recall_episode' | 'consolidate',
  input: unknown,
): Promise<T> {
  const url = `${getLeaderUrl()}/api/engine/${endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch (err) {
    // Network error → leader probably died. Try to take over.
    logger.warn({ err: (err as Error).message, endpoint }, 'leader unreachable, attempting promotion');
    const promoted = await tryPromoteToLeader();
    if (promoted) {
      // We're now leader. Retry as local.
      return runLocal(endpoint, input) as Promise<T>;
    }
    // Couldn't promote (someone else became leader, or no hook). Retry HTTP once.
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Leader returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.json() as T;
}

async function runLocal(endpoint: string, input: unknown): Promise<unknown> {
  switch (endpoint) {
    case 'working_memory': return workingMemoryLocal(input as WorkingMemoryInput);
    case 'associate':       return associateLocal(input as AssociateInput);
    case 'recall_episode':  return recallEpisodeLocal(input as RecallEpisodeInput);
    case 'consolidate':     return consolidateLocal(input as ConsolidateInput);
    default: throw new Error(`Unknown endpoint: ${endpoint}`);
  }
}

/** Dispatcher used by ContextFunction.execute — picks local vs forward. */
async function dispatch<T>(
  endpoint: 'working_memory' | 'associate' | 'recall_episode' | 'consolidate',
  input: unknown,
): Promise<T> {
  if (getRole() === 'follower') {
    return forwardToLeader<T>(endpoint, input);
  }
  return runLocal(endpoint, input) as Promise<T>;
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
    return dispatch('working_memory', input);
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
    return dispatch('associate', input);
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
    return dispatch('recall_episode', input);
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
    return dispatch('consolidate', input);
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
