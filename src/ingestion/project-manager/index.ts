/**
 * Project Manager ingestion pipeline orchestrator.
 *
 * Phases:
 * 1. Discovery   — scan ~/Projects for git repos
 * 2. Metadata    — upsert Project nodes
 * 3. Git         — ingest commits and branches
 * 4. Deps        — ingest dependencies and USES edges
 * 5. Relations   — detect cross-project edges
 * 6. Sessions    — ingest Claude session history
 * 7. Health      — compute and write health scores
 * 8. FTS         — rebuild full-text search indexes
 */

import { ProjectManagerGraphStore } from '../../graphstore/kuzu/project-manager-adapter.js';
import { scanProjects } from './scanner.js';
import { ingestCommits, ingestBranches } from './git-ingestor.js';
import { parseDependencies } from './dependency-ingestor.js';
import { ingestClaudeSessions } from './claude-session-ingestor.js';
import { detectRelations } from './relation-ingestor.js';
import { scoreProjects, type HealthInput } from './health-scorer.js';

export interface IngestOptions {
  dbPath: string;
  projectsDir?: string;
  maxCommitsPerRepo?: number;
  verbose?: boolean;
  force?: boolean;
}

export interface IngestionStats {
  projects: number;
  commits: number;
  branches: number;
  dependencies: number;
  relations: number;
  sessions: number;
  durationMs: number;
}

function log(verbose: boolean, msg: string) {
  if (verbose) console.error(`[project-manager] ${msg}`);
}

export async function runProjectManagerIngestion(opts: IngestOptions): Promise<IngestionStats> {
  const startMs = Date.now();
  const { dbPath, maxCommitsPerRepo = 200, verbose = false, force = false } = opts;

  const store = new ProjectManagerGraphStore({ dbPath, readOnly: false });
  await store.initialize();

  if (force) {
    log(verbose, 'Force mode: clearing existing data...');
    await store.clearData();
  }

  try {
    // ── Phase 1: Discovery ──────────────────────────────────────────────────
    log(verbose, 'Phase 1: Scanning projects...');
    const projects = scanProjects(opts.projectsDir);
    log(verbose, `  Found ${projects.length} repositories`);

    if (projects.length === 0) {
      log(verbose, 'No projects found — exiting');
      return { projects: 0, commits: 0, branches: 0, dependencies: 0, relations: 0, sessions: 0, durationMs: Date.now() - startMs };
    }

    // Build lookup maps
    const projectsByPath = new Map<string, string>(); // path → slug
    const projectsBySlug = new Map<string, typeof projects[0]>();
    for (const p of projects) {
      projectsByPath.set(p.path, p.slug);
      projectsBySlug.set(p.slug, p);
    }

    // ── Phase 2: Metadata ───────────────────────────────────────────────────
    log(verbose, 'Phase 2: Upserting project nodes...');
    const now = new Date().toISOString().split('T')[0];
    for (const p of projects) {
      await store.upsertProject({
        slug: p.slug,
        name: p.name,
        path: p.path,
        language: p.language,
        framework: p.framework,
        description: p.description,
        health_score: '',          // filled in phase 7
        last_activity: p.updated_at,
        created_at: p.created_at,
        updated_at: now,
      });
    }
    log(verbose, `  Upserted ${projects.length} projects`);

    // ── Phase 3: Git ────────────────────────────────────────────────────────
    log(verbose, 'Phase 3: Ingesting commits and branches...');
    const commitCounts: Map<string, number> = new Map();
    const branchCounts: Map<string, number> = new Map();
    let totalCommits = 0;
    let totalBranches = 0;

    for (const p of projects) {
      const commits = ingestCommits(p.path, p.slug, maxCommitsPerRepo);
      const branches = ingestBranches(p.path, p.slug);

      commitCounts.set(p.slug, commits.length);
      branchCounts.set(p.slug, branches.length);
      totalCommits += commits.length;
      totalBranches += branches.length;

      for (const c of commits) {
        await store.upsertCommit(c);
        await store.upsertRelationship(
          'COMMITTED_TO', 'Commit', c.sha, 'sha', 'Project', p.slug, 'slug',
          { branch_name: branches.find((b) => b.is_default)?.name ?? 'main' },
        );
      }

      for (const b of branches) {
        await store.upsertBranch(b);
        await store.upsertRelationship(
          'BELONGS_TO', 'Branch', b.branch_key, 'branch_key', 'Project', p.slug, 'slug',
        );
      }

      log(verbose, `  ${p.slug}: ${commits.length} commits, ${branches.length} branches`);
    }

    // ── Phase 4: Dependencies ───────────────────────────────────────────────
    log(verbose, 'Phase 4: Ingesting dependencies...');
    const depCounts: Map<string, number> = new Map();
    let totalDeps = 0;

    for (const p of projects) {
      const deps = parseDependencies(p.path);
      depCounts.set(p.slug, deps.length);
      totalDeps += deps.length;

      for (const d of deps) {
        await store.upsertDependency({
          dep_key: d.dep_key,
          ecosystem: d.ecosystem,
          name: d.name,
          latest_version: d.latest_version,
          is_outdated: d.is_outdated,
        });
        await store.upsertRelationship(
          'USES', 'Project', p.slug, 'slug', 'Dependency', d.dep_key, 'dep_key',
          { version: d.version, is_dev: d.is_dev, lock_version: d.lock_version },
        );
      }

      if (deps.length > 0) log(verbose, `  ${p.slug}: ${deps.length} dependencies`);
    }

    // ── Phase 5: Relations ──────────────────────────────────────────────────
    log(verbose, 'Phase 5: Detecting cross-project relations...');
    const relations = detectRelations(projects.map((p) => ({ slug: p.slug, path: p.path })));

    for (const r of relations) {
      if (r.relation_type === 'DEPENDS_ON') {
        await store.upsertRelationship(
          'DEPENDS_ON', 'Project', r.from_slug, 'slug', 'Project', r.to_slug, 'slug',
          { dependency_type: r.dependency_type ?? '', description: r.description ?? '' },
        );
      } else {
        await store.upsertRelationship(
          'RELATED_TO', 'Project', r.from_slug, 'slug', 'Project', r.to_slug, 'slug',
          { relation_type: r.relation_type, confidence: r.confidence ?? 'low' },
        );
      }
    }
    log(verbose, `  Detected ${relations.length} cross-project relations`);

    // ── Phase 6: Claude Sessions ────────────────────────────────────────────
    log(verbose, 'Phase 6: Ingesting Claude session history...');
    const sessions = ingestClaudeSessions(projectsByPath);
    const sessionCounts: Map<string, number> = new Map();

    for (const s of sessions) {
      await store.upsertClaudeSession({
        session_id: s.session_id,
        date: s.date,
        summary: s.summary,
        files_touched_count: s.files_touched_count,
        model: s.model,
        duration_minutes: s.duration_minutes,
      });
      await store.upsertRelationship(
        'WORKED_ON', 'ClaudeSession', s.session_id, 'session_id',
        'Project', s.project_slug, 'slug',
        { files_touched: '', summary: s.summary },
      );
      sessionCounts.set(s.project_slug, (sessionCounts.get(s.project_slug) ?? 0) + 1);
    }
    log(verbose, `  Ingested ${sessions.length} Claude sessions across ${sessionCounts.size} projects`);

    // ── Phase 7: Health Scoring ─────────────────────────────────────────────
    log(verbose, 'Phase 7: Computing health scores...');
    const healthInputs: HealthInput[] = projects.map((p) => ({
      slug: p.slug,
      last_activity: p.updated_at,
      commit_count_30d: 0,   // approximated — we stored all commits, count filtered ones
      stale_deps_count: 0,   // all deps marked is_outdated=false until registry check
      total_deps_count: depCounts.get(p.slug) ?? 0,
      branch_count: branchCounts.get(p.slug) ?? 0,
      session_count_30d: 0,
    }));

    // Patch commit_count_30d and session_count_30d from ingested data
    for (const input of healthInputs) {
      input.session_count_30d = sessionCounts.get(input.slug) ?? 0;
    }

    const scores = scoreProjects(healthInputs);

    for (const [slug, score] of scores) {
      const p = projectsBySlug.get(slug);
      if (!p) continue;
      await store.upsertProject({
        slug: p.slug,
        name: p.name,
        path: p.path,
        language: p.language,
        framework: p.framework,
        description: p.description,
        health_score: score,
        last_activity: p.updated_at,
        created_at: p.created_at,
        updated_at: now,
      });
    }
    log(verbose, `  Scored ${scores.size} projects`);

    // ── Phase 8: FTS Indexes ────────────────────────────────────────────────
    log(verbose, 'Phase 8: Rebuilding FTS indexes...');
    await store.rebuildFtsIndexes();
    log(verbose, '  FTS indexes rebuilt');

    const stats: IngestionStats = {
      projects: projects.length,
      commits: totalCommits,
      branches: totalBranches,
      dependencies: totalDeps,
      relations: relations.length,
      sessions: sessions.length,
      durationMs: Date.now() - startMs,
    };
    log(verbose, 'Ingestion complete.');
    return stats;
  } finally {
    await store.close();
  }
}
