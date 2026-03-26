// ─── Coding Bridge Context Functions ─────────────────────────────────────────
//
// Combines GitNexus code intelligence (symbols, call chains, blast radius) with
// Brainifai's knowledge graph (decisions, sessions, PR activity, people).
//
// GitNexus handles: what code does, how it connects, what it affects.
// Brainifai handles: who worked on it, why decisions were made, what changed.

import { z } from 'zod';
import type { ContextFunction } from '../types.js';
import { truncateEvidence } from '../../mcp/safety.js';
import { DEFAULT_WINDOW_DAYS } from '../../shared/constants.js';
import { execGitNexus, detectRepoName } from './gitnexus-client.js';

// Re-exported unchanged — no GitNexus enrichment needed for decision log
export { decisionLogFn } from './decision-log.js';

// ─── search_code ──────────────────────────────────────────────────────────────

export const searchCodeFn: ContextFunction = {
  name: 'search_code',
  description:
    'Search the codebase for symbols, execution flows, and code related to a concept (via GitNexus hybrid BM25+semantic search). Results are enriched with Brainifai knowledge: who worked on related areas and recent technical decisions.',
  schema: {
    query: z.string().describe('Search query — concept, symbol name, or feature area'),
    repo: z.string().optional().describe('Repository name (auto-detected from project dir if omitted)'),
    limit: z.number().int().min(1).max(20).default(5).describe('Max processes/symbols to return'),
    window_days: z
      .number().int().min(1).max(90).default(14)
      .describe('Days back to look for Brainifai activity enrichment'),
  },
  async execute(input, store) {
    const { query, repo, limit, window_days } = input as {
      query: string; repo?: string; limit?: number; window_days?: number;
    };

    const repoName = repo ?? detectRepoName();
    const maxItems = Math.min(limit ?? 5, 20);
    const windowDays = window_days ?? DEFAULT_WINDOW_DAYS;
    const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

    const gnArgs = ['-l', String(maxItems)];
    if (repoName) gnArgs.push('-r', repoName);

    const [gnResult, brainifaiActivity] = await Promise.all([
      execGitNexus('query', [query, ...gnArgs]),
      store.getRecentActivity({
        kinds: ['decision', 'insight', 'bug_fix', 'session_summary'],
        since: windowStart,
        limit: 20,
      }),
    ]);

    const codeResults = gnResult.ok
      ? gnResult.data
      : { unavailable: true, reason: gnResult.error.message };

    const activity = truncateEvidence(
      brainifaiActivity.map((i) => ({
        timestamp: i.timestamp,
        kind: i.kind,
        snippet: i.snippet,
        actor: i.actor,
        channel: i.channel,
      })),
      10,
    );

    return {
      query,
      repo: repoName,
      code_results: codeResults,
      brainifai_context: { recent_activity: activity, window_days: windowDays },
    };
  },
};

// ─── get_symbol_context ───────────────────────────────────────────────────────

export const symbolContextFn: ContextFunction = {
  name: 'get_symbol_context',
  description:
    '360-degree view of a code symbol: callers, callees, and execution processes (via GitNexus). Enriched with Brainifai decision log and session summaries to show the history of why this code area exists.',
  schema: {
    symbol: z.string().describe('Symbol name — function, class, or method'),
    repo: z.string().optional().describe('Repository name (auto-detected if omitted)'),
    file: z.string().optional().describe('File path to disambiguate common symbol names'),
    window_days: z
      .number().int().min(1).max(90).default(30)
      .describe('Days back to look for Brainifai decisions'),
  },
  async execute(input, store) {
    const { symbol, repo, file, window_days } = input as {
      symbol: string; repo?: string; file?: string; window_days?: number;
    };

    const repoName = repo ?? detectRepoName();
    const windowDays = window_days ?? DEFAULT_WINDOW_DAYS;
    const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

    const gnArgs: string[] = [];
    if (repoName) gnArgs.push('-r', repoName);
    if (file) gnArgs.push('-f', file);

    const [gnResult, decisions] = await Promise.all([
      execGitNexus('context', [symbol, ...gnArgs]),
      store.getRecentActivity({
        kinds: ['decision', 'insight', 'bug_fix', 'session_summary'],
        since: windowStart,
        limit: 15,
      }),
    ]);

    const symbolContext = gnResult.ok
      ? gnResult.data
      : { unavailable: true, reason: gnResult.error.message };

    const knowledgeContext = truncateEvidence(
      decisions.map((i) => ({
        timestamp: i.timestamp,
        kind: i.kind,
        snippet: i.snippet,
        actor: i.actor,
      })),
      10,
    );

    return {
      symbol,
      repo: repoName,
      symbol_context: symbolContext,
      brainifai_context: { decisions: knowledgeContext, window_days: windowDays },
    };
  },
};

// ─── get_blast_radius ─────────────────────────────────────────────────────────

export const blastRadiusFn: ContextFunction = {
  name: 'get_blast_radius',
  description:
    'Blast radius analysis: what breaks if a symbol changes (via GitNexus impact). Enriched with Brainifai context about who has been working in affected areas and recent sessions.',
  schema: {
    symbol: z.string().describe('Symbol to analyze'),
    repo: z.string().optional().describe('Repository name (auto-detected if omitted)'),
    direction: z
      .enum(['upstream', 'downstream'])
      .default('upstream')
      .describe('upstream = what depends on this symbol; downstream = what this symbol depends on'),
    depth: z.number().int().min(1).max(10).default(3).describe('Max relationship depth'),
    window_days: z
      .number().int().min(1).max(90).default(14)
      .describe('Days back to look for Brainifai session activity'),
  },
  async execute(input, store) {
    const { symbol, repo, direction, depth, window_days } = input as {
      symbol: string; repo?: string; direction?: string; depth?: number; window_days?: number;
    };

    const repoName = repo ?? detectRepoName();
    const dir = direction ?? 'upstream';
    const windowDays = window_days ?? DEFAULT_WINDOW_DAYS;
    const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

    const gnArgs = ['-d', dir, '--depth', String(depth ?? 3)];
    if (repoName) gnArgs.push('-r', repoName);

    const [gnResult, recentActivity] = await Promise.all([
      execGitNexus('impact', [symbol, ...gnArgs]),
      store.getRecentActivity({
        kinds: ['session_summary', 'decision', 'bug_fix'],
        since: windowStart,
        limit: 15,
      }),
    ]);

    const impactData = gnResult.ok
      ? gnResult.data
      : { unavailable: true, reason: gnResult.error.message };

    const activity = truncateEvidence(
      recentActivity.map((i) => ({
        timestamp: i.timestamp,
        kind: i.kind,
        snippet: i.snippet,
        actor: i.actor,
        channel: i.channel,
      })),
      10,
    );

    return {
      symbol,
      repo: repoName,
      direction: dir,
      impact: impactData,
      brainifai_context: { recent_sessions: activity, window_days: windowDays },
    };
  },
};

// ─── detect_code_changes ──────────────────────────────────────────────────────

export const detectChangesFn: ContextFunction = {
  name: 'detect_code_changes',
  description:
    'Map current git diff to affected processes and code areas (via GitNexus detect-changes). Enriched with Brainifai task and people context for the affected symbols.',
  schema: {
    repo: z.string().optional().describe('Repository name (auto-detected if omitted)'),
    window_days: z
      .number().int().min(1).max(90).default(7)
      .describe('Days back to look for Brainifai activity'),
  },
  async execute(input, store) {
    const { repo, window_days } = input as { repo?: string; window_days?: number };

    const repoName = repo ?? detectRepoName();
    const windowDays = window_days ?? 7;
    const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

    const gnArgs: string[] = [];
    if (repoName) gnArgs.push('--repo', repoName);

    const [gnResult, recentActivity] = await Promise.all([
      execGitNexus('detect-changes', gnArgs),
      store.getRecentActivity({ since: windowStart, limit: 20 }),
    ]);

    const changesData = gnResult.ok
      ? gnResult.data
      : { unavailable: true, reason: gnResult.error.message };

    const activity = truncateEvidence(
      recentActivity.map((i) => ({
        timestamp: i.timestamp,
        kind: i.kind,
        snippet: i.snippet,
        actor: i.actor,
        channel: i.channel,
      })),
      15,
    );

    return {
      repo: repoName,
      code_changes: changesData,
      brainifai_context: { recent_activity: activity, window_days: windowDays },
    };
  },
};

// ─── get_pr_context ───────────────────────────────────────────────────────────

export const prContextFn: ContextFunction = {
  name: 'get_pr_context',
  description:
    'Recent pull requests with optional code impact analysis. Combines Brainifai PR/review activity (grouped by repo) with GitNexus blast radius data when a symbol is provided.',
  schema: {
    window_days: z.number().int().min(1).max(365).default(14).describe('How many days back to look'),
    limit: z.number().int().min(1).max(50).default(20).describe('Maximum PRs to return'),
    symbol: z
      .string().optional()
      .describe('Optional symbol name — fetches GitNexus impact to show code areas affected by PRs'),
    repo: z.string().optional().describe('Repository name for GitNexus lookup (auto-detected if omitted)'),
  },
  async execute(input, store) {
    const { window_days, limit, symbol, repo } = input as {
      window_days?: number; limit?: number; symbol?: string; repo?: string;
    };

    const windowDays = window_days ?? DEFAULT_WINDOW_DAYS;
    const maxItems = Math.min(limit ?? 20, 50);
    const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

    // Fetch PR activity from Brainifai
    const items = await store.getRecentActivity({
      kinds: ['pull_request', 'pr_review', 'pr_comment'],
      since: windowStart,
      limit: maxItems,
    });

    const results = items.length > 0
      ? items
      : await store
          .getRecentActivity({ since: windowStart, limit: maxItems })
          .then((all) => all.filter((i) => i.source === 'github'));

    // Group by repo/channel
    const byRepo = new Map<string, typeof results>();
    for (const item of results) {
      const group = byRepo.get(item.channel) ?? [];
      group.push(item);
      byRepo.set(item.channel, group);
    }

    const grouped = Object.fromEntries(
      [...byRepo.entries()].map(([repoName, repoItems]) => [
        repoName,
        truncateEvidence(
          repoItems.map((i) => ({
            timestamp: i.timestamp,
            kind: i.kind,
            snippet: i.snippet,
            actor: i.actor,
            url: i.url,
          })),
          maxItems,
        ),
      ]),
    );

    // Optionally enrich with GitNexus blast radius for a referenced symbol
    let symbolImpact: unknown = undefined;
    if (symbol) {
      const repoName = repo ?? detectRepoName();
      const gnArgs = ['-d', 'upstream', '--depth', '3'];
      if (repoName) gnArgs.push('-r', repoName);
      const gnResult = await execGitNexus('impact', [symbol, ...gnArgs]);
      symbolImpact = {
        symbol,
        repo: repoName,
        impact: gnResult.ok ? gnResult.data : { unavailable: true, reason: gnResult.error.message },
      };
    }

    return {
      window_days: windowDays,
      repos: grouped,
      total: results.length,
      ...(symbolImpact !== undefined ? { symbol_impact: symbolImpact } : {}),
    };
  },
};
