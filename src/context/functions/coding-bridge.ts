/**
 * coding-bridge.ts — GitNexus × Brainifai bridge for the coding instance type.
 *
 * Each function calls a GitNexus CLI command for structural code intelligence
 * (call chains, blast radius, symbol context), then enriches the result with
 * relevant decisions, sessions, and activity from the Brainifai KG.
 *
 * Pattern for adding a new bridge function:
 *   1. Define the input schema (zod)
 *   2. Call runGitNexus([...args]) to get code-level data
 *   3. Extract keywords from the GN result
 *   4. Call enrichFromBrainifai(store, keywords) to get matching KG context
 *   5. Return both merged — do NOT lose information from either side
 *
 * CLI → output shape mapping (verified against live index):
 *   gitnexus query  → { processes[], process_symbols[], definitions[] }
 *   gitnexus context → { status, symbol, incoming.calls[], outgoing.calls[], processes[] }
 *   gitnexus impact  → { target, risk, impactedCount, summary, affected_processes[], affected_modules[], byDepth{} }
 *
 * Note: gitnexus requires --repo <name> when multiple repos are indexed.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';
import type { ContextFunction } from '../types.js';
import type { GraphStore } from '../../graphstore/types.js';
import { MAX_EVIDENCE_ITEMS } from '../../shared/constants.js';

const execFileAsync = promisify(execFile);

// ─── GitNexus CLI runner ───────────────────────────────────────────────────────

const GN_TIMEOUT_MS = 8_000;
const GN_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

/**
 * Execute a gitnexus CLI command and return the parsed JSON output.
 * Throws a clean Error (strips Node.js stack traces from stderr).
 */
async function runGitNexus(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync('gitnexus', args, {
      timeout: GN_TIMEOUT_MS,
      maxBuffer: GN_MAX_BUFFER,
    });
    return JSON.parse(stdout.trim());
  } catch (err: unknown) {
    const raw =
      (err as { stderr?: string; message?: string }).stderr ??
      (err as { message?: string }).message ??
      String(err);
    // Extract just the Error: line — gitnexus prints full Node stack traces
    const match = raw.match(/Error:\s*(.+)/);
    throw new Error(match ? match[1].trim() : raw.split('\n')[0].trim());
  }
}

/** Return ['--repo', name] when repo is specified, otherwise []. */
function repoArgs(repo?: string): string[] {
  return repo ? ['--repo', repo] : [];
}

// ─── Brainifai enrichment ──────────────────────────────────────────────────────

/**
 * Query the Brainifai KG for recent decisions, insights, bug fixes, and session
 * summaries whose snippet mentions any of the provided keywords.
 * Returns up to 5 matching items, truncated to 300 chars each.
 */
async function enrichFromBrainifai(
  store: GraphStore,
  keywords: string[],
  windowDays = 30,
): Promise<Array<{ timestamp: string; kind: string; snippet: string; channel: string }>> {
  const lower = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  if (lower.length === 0) return [];

  const since = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();
  const items = await store.getRecentActivity({
    kinds: ['decision', 'insight', 'bug_fix', 'session_summary'],
    since,
    limit: 40,
  });

  return items
    .filter((i) => {
      const hay = (i.snippet ?? '').toLowerCase();
      return lower.some((kw) => hay.includes(kw));
    })
    .slice(0, 5)
    .map((i) => ({
      timestamp: i.timestamp.slice(0, 10),
      kind: i.kind,
      snippet: i.snippet.slice(0, 300),
      channel: i.channel,
    }));
}

// ─── GitNexus output type definitions ─────────────────────────────────────────
// Derived from live CLI runs — keep in sync with gitnexus output changes.

interface GNProcess {
  id: string;
  summary: string;
  priority: number;
  symbol_count: number;
  process_type: string;
  step_count: number;
}

interface GNSymbolRef {
  id?: string;
  uid?: string;
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  module?: string;
}

interface GNQueryResult {
  processes: GNProcess[];
  process_symbols: GNSymbolRef[];
  definitions: GNSymbolRef[];
}

interface GNContextResult {
  status: string;
  symbol: {
    uid: string;
    name: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
  };
  incoming: { calls: GNSymbolRef[] };
  outgoing: { calls: GNSymbolRef[] };
  processes: Array<{ id: string; name: string; step_index: number; step_count: number }>;
}

interface GNImpactDepthEntry {
  depth: number;
  id: string;
  name: string;
  filePath: string;
  relationType: string;
  confidence: number;
}

interface GNImpactResult {
  target: { id: string; name: string; filePath: string };
  direction: string;
  impactedCount: number;
  risk: string; // "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
  summary: { direct: number; processes_affected: number; modules_affected: number };
  affected_processes: Array<{ name: string; hits: number; step_count: number }>;
  affected_modules: Array<{ name: string; hits: number; impact: string }>;
  byDepth: Record<string, GNImpactDepthEntry[]>;
}

// ─── Bridge context functions ──────────────────────────────────────────────────

/**
 * search_code
 * Hybrid search across the GitNexus knowledge graph for execution flows
 * related to a concept, enriched with Brainifai decisions and sessions.
 */
export const searchCodeFn: ContextFunction = {
  name: 'search_code',
  description:
    'Search the codebase for execution flows and symbols related to a concept. ' +
    'Returns matching processes, symbols, and definitions from GitNexus, ' +
    'enriched with related decisions and session history from Brainifai.',
  schema: {
    query: z.string().min(1).describe('Concept, feature, or topic to search for'),
    repo: z
      .string()
      .optional()
      .describe('Repository name — required when multiple repos are indexed'),
    limit: z.number().int().min(1).max(20).default(5).describe('Max processes to return'),
    context: z.string().optional().describe('Task context to improve result ranking'),
    goal: z.string().optional().describe('What you are trying to find or accomplish'),
  },
  async execute(input, store) {
    const { query, repo, limit, context, goal } = input as {
      query: string;
      repo?: string;
      limit?: number;
      context?: string;
      goal?: string;
    };

    const args = ['query', query, '--limit', String(limit ?? 5), ...repoArgs(repo)];
    if (context) args.push('--context', context);
    if (goal) args.push('--goal', goal);

    const gn = (await runGitNexus(args)) as GNQueryResult;

    // Keywords for enrichment: query term + process summaries + symbol names
    const keywords = [
      query,
      ...gn.processes.map((p) => p.summary),
      ...gn.process_symbols.slice(0, 10).map((s) => s.name),
    ];

    const brainifai = await enrichFromBrainifai(store, keywords);

    return {
      query,
      repo: repo ?? 'auto',
      processes: gn.processes,
      symbols: gn.process_symbols.slice(0, MAX_EVIDENCE_ITEMS),
      definitions: gn.definitions.slice(0, 10),
      brainifai_context: brainifai,
    };
  },
};

/**
 * get_symbol_context
 * 360-degree view of a code symbol: callers, callees, processes it participates in.
 * Enriched with Brainifai decisions and sessions that mention this symbol.
 */
export const getSymbolContextFn: ContextFunction = {
  name: 'get_symbol_context',
  description:
    '360-degree view of a code symbol: who calls it, what it calls, which ' +
    'execution processes it participates in. Enriched with related decisions ' +
    'and session summaries from Brainifai.',
  schema: {
    symbol: z.string().min(1).describe('Symbol name (function, class, method, interface)'),
    repo: z.string().optional().describe('Repository name'),
    file: z
      .string()
      .optional()
      .describe('File path to disambiguate symbols that share a name'),
  },
  async execute(input, store) {
    const { symbol, repo, file } = input as {
      symbol: string;
      repo?: string;
      file?: string;
    };

    const args = ['context', symbol, ...repoArgs(repo)];
    if (file) args.push('--file', file);

    const gn = (await runGitNexus(args)) as GNContextResult;

    if (gn.status !== 'found') {
      return {
        symbol,
        status: gn.status,
        message: 'Symbol not found in GitNexus index. Try a different name or --file to disambiguate.',
      };
    }

    const keywords = [
      symbol,
      gn.symbol.filePath,
      ...gn.incoming.calls.slice(0, 5).map((c) => c.name),
      ...gn.outgoing.calls.slice(0, 5).map((c) => c.name),
    ];

    const brainifai = await enrichFromBrainifai(store, keywords);

    return {
      symbol: gn.symbol,
      callers: gn.incoming.calls,
      callees: gn.outgoing.calls,
      processes: gn.processes,
      brainifai_context: brainifai,
    };
  },
};

/**
 * get_blast_radius
 * Blast radius analysis: what code is affected if a symbol or file changes?
 * Enriched with Brainifai decisions related to the affected modules/processes.
 */
export const getBlastRadiusFn: ContextFunction = {
  name: 'get_blast_radius',
  description:
    'Blast radius analysis: what code breaks or is affected if a symbol changes? ' +
    'Returns impacted modules, processes, and a risk level. ' +
    'Enriched with related Brainifai decisions and session history.',
  schema: {
    target: z.string().min(1).describe('Symbol name or file path to analyse'),
    repo: z.string().optional().describe('Repository name'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(3)
      .describe('Maximum relationship depth to traverse'),
    direction: z
      .enum(['upstream', 'downstream'])
      .default('upstream')
      .describe('upstream = what depends on this symbol; downstream = what this symbol depends on'),
  },
  async execute(input, store) {
    const { target, repo, depth, direction } = input as {
      target: string;
      repo?: string;
      depth?: number;
      direction?: 'upstream' | 'downstream';
    };

    const args = [
      'impact', target,
      '--depth', String(depth ?? 3),
      '--direction', direction ?? 'upstream',
      ...repoArgs(repo),
    ];

    const gn = (await runGitNexus(args)) as GNImpactResult;

    const depth1 = gn.byDepth['1'] ?? [];
    const keywords = [
      target,
      gn.target.filePath,
      ...gn.affected_modules.map((m) => m.name),
      ...depth1.slice(0, 5).map((s) => s.name),
    ];

    const brainifai = await enrichFromBrainifai(store, keywords);

    return {
      target: gn.target,
      risk: gn.risk,
      direction: gn.direction,
      impacted_count: gn.impactedCount,
      summary: gn.summary,
      affected_processes: gn.affected_processes.slice(0, 10),
      affected_modules: gn.affected_modules,
      direct_dependants: depth1.slice(0, 15),
      brainifai_context: brainifai,
    };
  },
};

/**
 * detect_code_changes
 * Given a list of changed symbols or files (e.g. extracted from a git diff),
 * maps each change to its blast radius and aggregates the full set of affected
 * processes and modules. Enriched with Brainifai task and people context.
 *
 * Note: gitnexus has no dedicated detect_changes CLI command; this function
 * composes `gitnexus impact` across the provided change list and merges results.
 */
export const detectCodeChangesFn: ContextFunction = {
  name: 'detect_code_changes',
  description:
    'Map a set of changed symbols or files to their aggregate blast radius. ' +
    'Accepts a list of changed identifiers (from a git diff or PR) and returns ' +
    'the union of all affected processes and modules, plus related Brainifai context.',
  schema: {
    changes: z
      .array(z.string())
      .min(1)
      .max(10)
      .describe('Changed symbol names or file paths (from a diff or PR)'),
    repo: z.string().optional().describe('Repository name'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(4)
      .default(2)
      .describe('Impact depth to traverse per change'),
  },
  async execute(input, store) {
    const { changes, repo, depth } = input as {
      changes: string[];
      repo?: string;
      depth?: number;
    };

    // Cap at 5 targets to stay within the overall query timeout
    const targets = changes.slice(0, 5);

    const settled = await Promise.allSettled(
      targets.map((t) =>
        runGitNexus([
          'impact', t,
          '--depth', String(depth ?? 2),
          '--direction', 'upstream',
          ...repoArgs(repo),
        ]).then((r) => ({ target: t, result: r as GNImpactResult })),
      ),
    );

    // Aggregate across all targets: sum hits per process/module
    const processMap = new Map<string, { name: string; hits: number }>();
    const moduleMap = new Map<string, { name: string; hits: number; impact: string }>();
    const perChange: Array<{ target: string; risk: string; impacted: number; error?: string }> = [];
    const keywords: string[] = [...changes];

    for (const s of settled) {
      if (s.status === 'rejected') {
        // Surface per-target errors without failing the whole call
        const idx = settled.indexOf(s);
        perChange.push({
          target: targets[idx] ?? 'unknown',
          risk: 'UNKNOWN',
          impacted: 0,
          error: (s.reason as Error).message,
        });
        continue;
      }
      const { target, result } = s.value;
      perChange.push({ target, risk: result.risk, impacted: result.impactedCount });
      for (const p of result.affected_processes) {
        const entry = processMap.get(p.name) ?? { name: p.name, hits: 0 };
        entry.hits += p.hits;
        processMap.set(p.name, entry);
      }
      for (const m of result.affected_modules) {
        const entry = moduleMap.get(m.name) ?? { name: m.name, hits: 0, impact: m.impact };
        entry.hits += m.hits;
        moduleMap.set(m.name, entry);
      }
      keywords.push(...result.affected_modules.map((m) => m.name));
    }

    const brainifai = await enrichFromBrainifai(store, keywords);

    return {
      changes: perChange,
      aggregated_processes: [...processMap.values()]
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 15),
      aggregated_modules: [...moduleMap.values()].sort((a, b) => b.hits - a.hits),
      brainifai_context: brainifai,
    };
  },
};

/**
 * get_pr_context
 * Recent pull requests from Brainifai, optionally enriched with GitNexus
 * blast-radius analysis on specific symbols touched by those PRs.
 */
export const getPrContextFn: ContextFunction = {
  name: 'get_pr_context',
  description:
    'Recent pull requests from the knowledge graph, enriched with GitNexus impact analysis. ' +
    'Pass enrich_symbols to get blast-radius data for specific symbols mentioned in the PRs.',
  schema: {
    window_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(14)
      .describe('How many days back to look'),
    limit: z.number().int().min(1).max(20).default(10).describe('Maximum PRs to return'),
    repo: z
      .string()
      .optional()
      .describe('Repository name for GitNexus impact lookup'),
    enrich_symbols: z
      .array(z.string())
      .max(3)
      .optional()
      .describe('Up to 3 symbol names to run blast-radius analysis on'),
  },
  async execute(input, store) {
    const { window_days, limit, repo, enrich_symbols } = input as {
      window_days?: number;
      limit?: number;
      repo?: string;
      enrich_symbols?: string[];
    };

    const windowDays = window_days ?? 14;
    const maxItems = Math.min(limit ?? 10, 20);
    const since = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

    // Fetch PR activity from Brainifai
    const prItems = await store.getRecentActivity({
      kinds: ['pull_request', 'pr_review', 'pr_comment'],
      since,
      limit: maxItems,
    });

    // Fall back to all GitHub-sourced activity if no PR-specific kinds exist
    const results =
      prItems.length > 0
        ? prItems
        : await store
            .getRecentActivity({ since, limit: maxItems })
            .then((all) => all.filter((i) => i.source === 'github'));

    // Group by channel (repo name)
    const byRepo = new Map<string, typeof results>();
    for (const item of results) {
      const group = byRepo.get(item.channel) ?? [];
      group.push(item);
      byRepo.set(item.channel, group);
    }

    // Run GitNexus impact on requested symbols (cap at 3)
    let impactData: unknown[] = [];
    if (enrich_symbols && enrich_symbols.length > 0) {
      const settled = await Promise.allSettled(
        enrich_symbols.slice(0, 3).map((sym) =>
          runGitNexus(['impact', sym, '--depth', '2', ...repoArgs(repo)]).then((r) => ({
            symbol: sym,
            impact: r as GNImpactResult,
          })),
        ),
      );
      impactData = settled
        .filter(
          (
            s,
          ): s is PromiseFulfilledResult<{
            symbol: string;
            impact: GNImpactResult;
          }> => s.status === 'fulfilled',
        )
        .map((s) => ({
          symbol: s.value.symbol,
          risk: s.value.impact.risk,
          impacted_count: s.value.impact.impactedCount,
          affected_modules: s.value.impact.affected_modules,
          affected_processes: s.value.impact.affected_processes.slice(0, 5),
        }));
    }

    return {
      window_days: windowDays,
      total: results.length,
      by_repo: Object.fromEntries(
        [...byRepo.entries()].map(([r, items]) => [
          r,
          items.map((i) => ({
            timestamp: i.timestamp,
            kind: i.kind,
            snippet: i.snippet.slice(0, 300),
            actor: i.actor,
            url: i.url,
          })),
        ]),
      ),
      gitnexus_impact: impactData.length > 0 ? impactData : null,
    };
  },
};
