/**
 * Project Manager context functions — 7 portfolio query tools.
 *
 * These bypass the base GraphStore and use ProjectManagerGraphStore directly.
 * Each call opens a short-lived read-only connection to avoid holding locks.
 */

import { z } from 'zod';
import type { ContextFunction } from '../types.js';
import { ProjectManagerGraphStore } from '../../graphstore/kuzu/project-manager-adapter.js';
import { resolveInstanceDbPath } from '../../instance/resolve.js';
import { resolve } from 'path';

/** Open a short-lived read-only ProjectManagerGraphStore, run callback, then close. */
async function withStore<T>(fn: (store: ProjectManagerGraphStore) => Promise<T>): Promise<T> {
  const instancePath = resolveInstanceDbPath();
  const dbPath = resolve(instancePath, 'data', 'kuzu');
  const store = new ProjectManagerGraphStore({ dbPath, readOnly: true });
  try {
    await store.initialize();
    return await fn(store);
  } finally {
    await store.close();
  }
}

// ─── 1. search_projects ───────────────────────────────────────────────────────

export const searchProjectsFn: ContextFunction = {
  name: 'search_projects',
  description: 'Full-text search across projects by name, description, or framework',
  schema: {
    query: z.string().describe('Search text (project name, framework, description keyword)'),
    limit: z.number().int().min(1).max(50).default(20)
      .describe('Maximum results to return'),
  },
  async execute(input) {
    const { query, limit } = input as { query: string; limit?: number };
    return withStore(async (store) => {
      const projects = await store.searchProjects(query, limit ?? 20);
      return {
        projects,
        record_ids: projects.map((p) => p.slug),
      };
    });
  },
};

// ─── 2. get_project_health ────────────────────────────────────────────────────

export const getProjectHealthFn: ContextFunction = {
  name: 'get_project_health',
  description: 'Get health report for a project: health score, staleness, dependency freshness, recent commits, and branch count',
  schema: {
    project_slug: z.string().describe('The project slug (basename of the repo directory)'),
  },
  async execute(input) {
    const { project_slug } = input as { project_slug: string };
    return withStore(async (store) => {
      const report = await store.getProjectHealth(project_slug);
      if (!report) return { error: `Project '${project_slug}' not found` };
      return {
        ...report,
        record_ids: [
          report.project.slug,
          ...report.recent_commits.map((c) => c.sha),
          ...report.branches.map((b) => b.branch_key),
          ...report.dependencies.map((d) => d.dep_key),
        ],
      };
    });
  },
};

// ─── 3. get_project_activity ──────────────────────────────────────────────────

export const getProjectActivityFn: ContextFunction = {
  name: 'get_project_activity',
  description: 'Get recent activity for a project: commits, Claude sessions, and tasks within a time window',
  schema: {
    project_slug: z.string().describe('The project slug'),
    window_days: z.number().int().min(1).max(365).default(30)
      .describe('Look-back window in days'),
    limit: z.number().int().min(1).max(100).default(20)
      .describe('Maximum items per category'),
  },
  async execute(input) {
    const { project_slug, window_days, limit } = input as {
      project_slug: string; window_days?: number; limit?: number;
    };
    return withStore(async (store) => {
      const report = await store.getProjectActivity(project_slug, {
        windowDays: window_days ?? 30,
        limit: limit ?? 20,
      });
      return {
        ...report,
        record_ids: [
          project_slug,
          ...report.commits.map((c) => c.sha),
          ...report.sessions.map((s) => s.session_id),
          ...report.tasks.map((t) => t.task_id),
        ],
      };
    });
  },
};

// ─── 4. get_cross_project_impact ──────────────────────────────────────────────

export const getCrossProjectImpactFn: ContextFunction = {
  name: 'get_cross_project_impact',
  description: 'Multi-hop graph traversal to find projects affected by changes to a given project, and projects that depend on it',
  schema: {
    project_slug: z.string().describe('The source project slug'),
    depth: z.number().int().min(1).max(4).default(2)
      .describe('Maximum traversal depth (1 = direct deps only, 2+ = transitive)'),
  },
  async execute(input) {
    const { project_slug, depth } = input as { project_slug: string; depth?: number };
    return withStore(async (store) => {
      const impact = await store.getCrossProjectImpact(project_slug, depth ?? 2);
      return {
        ...impact,
        record_ids: [
          project_slug,
          ...impact.affected_projects.map((p) => p.slug),
        ],
      };
    });
  },
};

// ─── 5. find_stale_projects ───────────────────────────────────────────────────

export const findStaleProjectsFn: ContextFunction = {
  name: 'find_stale_projects',
  description: 'Find repositories with no commit or session activity above a staleness threshold',
  schema: {
    days_threshold: z.number().int().min(1).max(730).default(30)
      .describe('Projects inactive for more than this many days are considered stale'),
  },
  async execute(input) {
    const { days_threshold } = input as { days_threshold?: number };
    return withStore(async (store) => {
      const stale = await store.findStaleProjects(days_threshold ?? 30);
      return {
        stale_projects: stale,
        count: stale.length,
        record_ids: stale.map((s) => s.project.slug),
      };
    });
  },
};

// ─── 6. get_dependency_graph ──────────────────────────────────────────────────

export const getDependencyGraphFn: ContextFunction = {
  name: 'get_dependency_graph',
  description: 'Get shared dependencies across projects with version mismatch detection. Optionally filter to a single project.',
  schema: {
    project_slug: z.string().optional()
      .describe('If provided, return only dependencies for this project'),
  },
  async execute(input) {
    const { project_slug } = input as { project_slug?: string };
    return withStore(async (store) => {
      const graph = await store.getDependencyGraph(project_slug);
      const depIds = graph.dependencies.map((d) => d.dep.dep_key);
      return {
        ...graph,
        mismatches_count: graph.dependencies.filter((d) => d.version_mismatch).length,
        record_ids: depIds,
      };
    });
  },
};

// ─── 7. get_claude_session_history ────────────────────────────────────────────

export const getClaudeSessionHistoryFn: ContextFunction = {
  name: 'get_claude_session_history',
  description: 'Audit trail of Claude Code sessions for a project — what was worked on, when, and which files were touched',
  schema: {
    project_slug: z.string().describe('The project slug'),
    window_days: z.number().int().min(1).max(365).default(90)
      .describe('Look-back window in days'),
    limit: z.number().int().min(1).max(100).default(50)
      .describe('Maximum sessions to return'),
  },
  async execute(input) {
    const { project_slug, window_days, limit } = input as {
      project_slug: string; window_days?: number; limit?: number;
    };
    return withStore(async (store) => {
      const sessions = await store.getClaudeSessionHistory(project_slug, {
        windowDays: window_days ?? 90,
        limit: limit ?? 50,
      });
      return {
        project_slug,
        sessions,
        count: sessions.length,
        record_ids: [project_slug, ...sessions.map((s) => s.session_id)],
      };
    });
  },
};
