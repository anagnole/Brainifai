/**
 * Health scorer — computes a health score string for each project
 * based on commit recency, dependency freshness, branch count, and session activity.
 *
 * Scores: "excellent" | "good" | "fair" | "poor" | "unknown"
 */

export interface HealthInput {
  slug: string;
  last_activity: string;       // ISO date string or empty
  commit_count_30d: number;
  stale_deps_count: number;
  total_deps_count: number;
  branch_count: number;
  session_count_30d: number;
}

export type HealthScore = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

function daysSince(dateStr: string): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Score a project 0–100 across several dimensions:
 * - Recency (40 pts): recent commits/activity
 * - Dep freshness (30 pts): low % outdated deps
 * - Engagement (30 pts): Claude sessions, branch hygiene
 */
export function computeHealthScore(input: HealthInput): HealthScore {
  if (!input.last_activity && input.commit_count_30d === 0) return 'unknown';

  let score = 0;

  // ── Recency (40 pts) ────────────────────────────────────────────────────────
  const days = daysSince(input.last_activity);
  if (days !== null) {
    if (days <= 7) score += 40;
    else if (days <= 14) score += 32;
    else if (days <= 30) score += 24;
    else if (days <= 60) score += 16;
    else if (days <= 90) score += 8;
    // > 90 days: 0 pts
  }

  // Bonus for commit cadence
  if (input.commit_count_30d >= 20) score += 10;
  else if (input.commit_count_30d >= 10) score += 7;
  else if (input.commit_count_30d >= 5) score += 4;
  else if (input.commit_count_30d >= 1) score += 2;

  // ── Dep freshness (30 pts) ──────────────────────────────────────────────────
  if (input.total_deps_count > 0) {
    const staleRatio = input.stale_deps_count / input.total_deps_count;
    if (staleRatio === 0) score += 30;
    else if (staleRatio < 0.1) score += 24;
    else if (staleRatio < 0.25) score += 18;
    else if (staleRatio < 0.5) score += 10;
    else score += 4;
  } else {
    score += 15; // no deps → neutral
  }

  // ── Engagement (30 pts) ─────────────────────────────────────────────────────
  if (input.session_count_30d >= 5) score += 20;
  else if (input.session_count_30d >= 2) score += 14;
  else if (input.session_count_30d >= 1) score += 8;

  // Branch hygiene: fewer stale branches = cleaner project
  if (input.branch_count <= 3) score += 10;
  else if (input.branch_count <= 8) score += 6;
  else if (input.branch_count <= 15) score += 3;

  // ── Bucket into label ────────────────────────────────────────────────────────
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 35) return 'fair';
  return 'poor';
}

/** Batch-score a list of projects and return slug → score map. */
export function scoreProjects(inputs: HealthInput[]): Map<string, HealthScore> {
  const map = new Map<string, HealthScore>();
  for (const input of inputs) {
    map.set(input.slug, computeHealthScore(input));
  }
  return map;
}
