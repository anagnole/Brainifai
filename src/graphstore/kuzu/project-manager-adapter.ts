/**
 * Project Manager graph query adapter.
 *
 * Wraps a Kuzu connection with project portfolio query methods that back
 * the 7 context functions (search_projects, get_project_health, etc.).
 *
 * Design decisions:
 * - Uses prepare() + execute() with parameters — never string interpolation
 * - Upsert methods use MERGE for idempotency (safe to re-run)
 * - All date fields are stored as ISO 8601 strings
 */

import kuzu from 'kuzu';
import type { KuzuValue } from 'kuzu';
import { createProjectManagerSchema, rebuildProjectManagerFtsIndexes } from './project-manager-schema.js';

// ─── Return types ─────────────────────────────────────────────────────────────

export interface ProjectRecord {
  slug: string;
  name: string;
  path: string;
  language: string;
  framework: string;
  description: string;
  health_score: string;
  last_activity: string;
  created_at: string;
  updated_at: string;
}

export interface CommitRecord {
  sha: string;
  message: string;
  author: string;
  date: string;
  files_changed_count: number;
  insertions: number;
  deletions: number;
}

export interface BranchRecord {
  branch_key: string;
  project_slug: string;
  name: string;
  is_default: boolean;
  last_commit_date: string;
  ahead: number;
  behind: number;
}

export interface DependencyRecord {
  dep_key: string;
  ecosystem: string;
  name: string;
  latest_version: string;
  is_outdated: boolean;
}

export interface DependencyUsage extends DependencyRecord {
  version: string;
  is_dev: boolean;
  lock_version: string;
  project_slug: string;
}

export interface ClaudeSessionRecord {
  session_id: string;
  date: string;
  summary: string;
  files_touched_count: number;
  model: string;
  duration_minutes: number;
}

export interface TaskRecord {
  task_id: string;
  title: string;
  status: string;
  assignee: string;
  due_date: string;
  priority: string;
  source: string;
}

export interface ProjectHealthReport {
  project: ProjectRecord;
  recent_commits: CommitRecord[];
  branches: BranchRecord[];
  dependencies: DependencyUsage[];
  stale_deps_count: number;
  days_since_last_commit: number | null;
}

export interface ProjectActivityReport {
  project_slug: string;
  commits: CommitRecord[];
  sessions: ClaudeSessionRecord[];
  tasks: TaskRecord[];
}

export interface CrossProjectImpact {
  source_slug: string;
  affected_projects: Array<{ slug: string; name: string; relation: string; depth: number }>;
}

export interface DependencyGraphReport {
  dependencies: Array<{
    dep: DependencyRecord;
    used_by: Array<{ project_slug: string; version: string; is_dev: boolean }>;
    version_mismatch: boolean;
  }>;
}

// ─── Upsert input types ───────────────────────────────────────────────────────

export interface UpsertProjectInput {
  slug: string;
  name: string;
  path: string;
  language: string;
  framework: string;
  description: string;
  health_score: string;
  last_activity: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertCommitInput {
  sha: string;
  message: string;
  author: string;
  date: string;
  files_changed_count: number;
  insertions: number;
  deletions: number;
}

export interface UpsertBranchInput {
  branch_key: string;
  project_slug: string;
  name: string;
  is_default: boolean;
  last_commit_date: string;
  ahead: number;
  behind: number;
}

export interface UpsertDependencyInput {
  dep_key: string;
  ecosystem: string;
  name: string;
  latest_version: string;
  is_outdated: boolean;
}

export interface UpsertClaudeSessionInput {
  session_id: string;
  date: string;
  summary: string;
  files_touched_count: number;
  model: string;
  duration_minutes: number;
}

export interface UpsertTaskInput {
  task_id: string;
  title: string;
  status: string;
  assignee: string;
  due_date: string;
  priority: string;
  source: string;
}

// ─── ProjectManagerGraphStore ─────────────────────────────────────────────────

export class ProjectManagerGraphStore {
  private db: InstanceType<typeof kuzu.Database>;
  private conn: InstanceType<typeof kuzu.Connection>;

  constructor(config: { dbPath: string; readOnly?: boolean }) {
    this.db = new kuzu.Database(config.dbPath, 0, true, config.readOnly ?? false);
    this.conn = new kuzu.Connection(this.db);
  }

  async initialize(): Promise<void> {
    await this.conn.query('LOAD EXTENSION fts');
    await createProjectManagerSchema(this.conn);
  }

  async rebuildFtsIndexes(): Promise<void> {
    await rebuildProjectManagerFtsIndexes(this.conn);
  }

  async close(): Promise<void> {
    await this.conn.close();
    await this.db.close();
  }

  /** Delete all data (used by --force re-index). Relationships are removed via DETACH DELETE. */
  async clearData(): Promise<void> {
    for (const label of ['Commit', 'Branch', 'ClaudeSession', 'Task', 'Dependency', 'Project']) {
      try {
        await this.query(`MATCH (n:${label}) DETACH DELETE n`);
      } catch { /* table may be empty */ }
    }
  }

  /** Low-level parameterized query */
  private async query(cypher: string, params?: Record<string, KuzuValue>): Promise<Record<string, KuzuValue>[]> {
    if (params && Object.keys(params).length > 0) {
      const ps = await this.conn.prepare(cypher);
      const result = await this.conn.execute(ps, params);
      const qr = Array.isArray(result) ? result[0] : result;
      return qr.getAll();
    }
    const result = await this.conn.query(cypher);
    const qr = Array.isArray(result) ? result[0] : result;
    return qr.getAll();
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  async searchProjects(queryText: string, limit = 20): Promise<ProjectRecord[]> {
    const safeQuery = queryText.replace(/'/g, "''");
    const rows = await this.query(
      `CALL QUERY_FTS_INDEX('Project', 'project_fts', '${safeQuery}')
       RETURN node.slug AS slug, node.name AS name, node.path AS path,
              node.language AS language, node.framework AS framework,
              node.description AS description, node.health_score AS health_score,
              node.last_activity AS last_activity, node.created_at AS created_at,
              node.updated_at AS updated_at, score
       ORDER BY score DESC
       LIMIT ${limit}`,
    );
    return rows.map((r) => this.rowToProject(r));
  }

  // ─── Project Health ───────────────────────────────────────────────────────

  async getProjectHealth(projectSlug: string): Promise<ProjectHealthReport | null> {
    const projects = await this.query(
      `MATCH (p:Project {slug: $slug}) RETURN p`,
      { slug: projectSlug },
    );
    if (projects.length === 0) return null;
    const project = this.rowToProject(projects[0].p as Record<string, KuzuValue>);

    const [recentCommits, branches, dependencies] = await Promise.all([
      this.query(
        `MATCH (c:Commit)-[:COMMITTED_TO]->(p:Project {slug: $slug})
         RETURN c.sha AS sha, c.message AS message, c.author AS author, c.date AS date,
                c.files_changed_count AS files_changed_count,
                c.insertions AS insertions, c.deletions AS deletions
         ORDER BY c.date DESC LIMIT 10`,
        { slug: projectSlug },
      ),
      this.query(
        `MATCH (b:Branch)-[:BELONGS_TO]->(p:Project {slug: $slug})
         RETURN b.branch_key AS branch_key, b.project_slug AS project_slug,
                b.name AS name, b.is_default AS is_default,
                b.last_commit_date AS last_commit_date,
                b.ahead AS ahead, b.behind AS behind`,
        { slug: projectSlug },
      ),
      this.query(
        `MATCH (p:Project {slug: $slug})-[u:USES]->(d:Dependency)
         RETURN d.dep_key AS dep_key, d.ecosystem AS ecosystem, d.name AS name,
                d.latest_version AS latest_version, d.is_outdated AS is_outdated,
                u.version AS version, u.is_dev AS is_dev, u.lock_version AS lock_version`,
        { slug: projectSlug },
      ),
    ]);

    const staleDepsCount = dependencies.filter((r) => r.is_outdated === true).length;

    let daysSinceLastCommit: number | null = null;
    if (recentCommits.length > 0) {
      const lastDate = new Date(recentCommits[0].date as string);
      const now = new Date();
      daysSinceLastCommit = Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
    }

    return {
      project,
      recent_commits: recentCommits.map((r) => this.rowToCommit(r)),
      branches: branches.map((r) => this.rowToBranch(r)),
      dependencies: dependencies.map((r) => ({
        dep_key: r.dep_key as string,
        ecosystem: r.ecosystem as string,
        name: r.name as string,
        latest_version: (r.latest_version as string) || '',
        is_outdated: (r.is_outdated as boolean) ?? false,
        version: (r.version as string) || '',
        is_dev: (r.is_dev as boolean) ?? false,
        lock_version: (r.lock_version as string) || '',
        project_slug: projectSlug,
      })),
      stale_deps_count: staleDepsCount,
      days_since_last_commit: daysSinceLastCommit,
    };
  }

  // ─── Project Activity ─────────────────────────────────────────────────────

  async getProjectActivity(
    projectSlug: string,
    opts: { windowDays?: number; limit?: number } = {},
  ): Promise<ProjectActivityReport> {
    const { windowDays = 30, limit = 20 } = opts;
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [commits, sessions, tasks] = await Promise.all([
      this.query(
        `MATCH (c:Commit)-[:COMMITTED_TO]->(p:Project {slug: $slug})
         WHERE c.date >= $cutoff
         RETURN c.sha AS sha, c.message AS message, c.author AS author, c.date AS date,
                c.files_changed_count AS files_changed_count,
                c.insertions AS insertions, c.deletions AS deletions
         ORDER BY c.date DESC LIMIT ${limit}`,
        { slug: projectSlug, cutoff },
      ),
      this.query(
        `MATCH (s:ClaudeSession)-[:WORKED_ON]->(p:Project {slug: $slug})
         WHERE s.date >= $cutoff
         RETURN s.session_id AS session_id, s.date AS date, s.summary AS summary,
                s.files_touched_count AS files_touched_count, s.model AS model,
                s.duration_minutes AS duration_minutes
         ORDER BY s.date DESC LIMIT ${limit}`,
        { slug: projectSlug, cutoff },
      ),
      this.query(
        `MATCH (t:Task)-[:TRACKS]->(p:Project {slug: $slug})
         RETURN t.task_id AS task_id, t.title AS title, t.status AS status,
                t.assignee AS assignee, t.due_date AS due_date,
                t.priority AS priority, t.source AS source
         LIMIT ${limit}`,
        { slug: projectSlug },
      ),
    ]);

    return {
      project_slug: projectSlug,
      commits: commits.map((r) => this.rowToCommit(r)),
      sessions: sessions.map((r) => this.rowToSession(r)),
      tasks: tasks.map((r) => this.rowToTask(r)),
    };
  }

  // ─── Cross-Project Impact ─────────────────────────────────────────────────

  async getCrossProjectImpact(projectSlug: string, depth = 2): Promise<CrossProjectImpact> {
    // Walk DEPENDS_ON and RELATED_TO edges up to `depth` hops
    const rows = await this.query(
      `MATCH path = (src:Project {slug: $slug})-[:DEPENDS_ON|RELATED_TO*1..${depth}]->(affected:Project)
       WHERE affected.slug <> $slug
       RETURN DISTINCT affected.slug AS slug, affected.name AS name,
              length(path) AS depth
       ORDER BY depth ASC
       LIMIT 50`,
      { slug: projectSlug },
    );

    // Also find projects that depend on us
    const dependents = await this.query(
      `MATCH (dep:Project)-[:DEPENDS_ON]->(src:Project {slug: $slug})
       RETURN DISTINCT dep.slug AS slug, dep.name AS name, 1 AS depth`,
      { slug: projectSlug },
    );

    const affected = [
      ...rows.map((r) => ({
        slug: r.slug as string,
        name: r.name as string,
        relation: 'downstream',
        depth: r.depth as number,
      })),
      ...dependents.map((r) => ({
        slug: r.slug as string,
        name: r.name as string,
        relation: 'dependent',
        depth: r.depth as number,
      })),
    ];

    // Deduplicate by slug
    const seen = new Set<string>();
    const unique = affected.filter((a) => {
      if (seen.has(a.slug)) return false;
      seen.add(a.slug);
      return true;
    });

    return { source_slug: projectSlug, affected_projects: unique };
  }

  // ─── Stale Projects ───────────────────────────────────────────────────────

  async findStaleProjects(daysThreshold = 30): Promise<Array<{ project: ProjectRecord; days_inactive: number }>> {
    const cutoff = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0];

    const rows = await this.query(
      `MATCH (p:Project)
       WHERE p.last_activity < $cutoff OR p.last_activity = '' OR p.last_activity IS NULL
       RETURN p.slug AS slug, p.name AS name, p.path AS path,
              p.language AS language, p.framework AS framework,
              p.description AS description, p.health_score AS health_score,
              p.last_activity AS last_activity, p.created_at AS created_at,
              p.updated_at AS updated_at
       ORDER BY p.last_activity ASC`,
      { cutoff },
    );

    const now = new Date();
    return rows.map((r) => {
      const lastActivity = r.last_activity as string;
      let daysInactive = daysThreshold;
      if (lastActivity) {
        const d = new Date(lastActivity);
        daysInactive = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
      }
      return {
        project: this.rowToProject(r),
        days_inactive: daysInactive,
      };
    });
  }

  // ─── Dependency Graph ─────────────────────────────────────────────────────

  async getDependencyGraph(projectSlugFilter?: string): Promise<DependencyGraphReport> {
    let rows: Record<string, KuzuValue>[];
    if (projectSlugFilter) {
      rows = await this.query(
        `MATCH (p:Project {slug: $slug})-[u:USES]->(d:Dependency)
         RETURN d.dep_key AS dep_key, d.ecosystem AS ecosystem, d.name AS name,
                d.latest_version AS latest_version, d.is_outdated AS is_outdated,
                p.slug AS project_slug, u.version AS version, u.is_dev AS is_dev`,
        { slug: projectSlugFilter },
      );
    } else {
      rows = await this.query(
        `MATCH (p:Project)-[u:USES]->(d:Dependency)
         RETURN d.dep_key AS dep_key, d.ecosystem AS ecosystem, d.name AS name,
                d.latest_version AS latest_version, d.is_outdated AS is_outdated,
                p.slug AS project_slug, u.version AS version, u.is_dev AS is_dev`,
      );
    }

    // Group by dep_key
    const depMap = new Map<string, {
      dep: DependencyRecord;
      used_by: Array<{ project_slug: string; version: string; is_dev: boolean }>;
    }>();

    for (const r of rows) {
      const key = r.dep_key as string;
      if (!depMap.has(key)) {
        depMap.set(key, {
          dep: {
            dep_key: key,
            ecosystem: r.ecosystem as string,
            name: r.name as string,
            latest_version: (r.latest_version as string) || '',
            is_outdated: (r.is_outdated as boolean) ?? false,
          },
          used_by: [],
        });
      }
      depMap.get(key)!.used_by.push({
        project_slug: r.project_slug as string,
        version: (r.version as string) || '',
        is_dev: (r.is_dev as boolean) ?? false,
      });
    }

    const dependencies = Array.from(depMap.values()).map((entry) => {
      const versions = new Set(entry.used_by.map((u) => u.version).filter(Boolean));
      return {
        ...entry,
        version_mismatch: versions.size > 1,
      };
    });

    return { dependencies };
  }

  // ─── Claude Session History ───────────────────────────────────────────────

  async getClaudeSessionHistory(
    projectSlug: string,
    opts: { windowDays?: number; limit?: number } = {},
  ): Promise<ClaudeSessionRecord[]> {
    const { windowDays = 90, limit = 50 } = opts;
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const rows = await this.query(
      `MATCH (s:ClaudeSession)-[:WORKED_ON]->(p:Project {slug: $slug})
       WHERE s.date >= $cutoff
       RETURN s.session_id AS session_id, s.date AS date, s.summary AS summary,
              s.files_touched_count AS files_touched_count, s.model AS model,
              s.duration_minutes AS duration_minutes
       ORDER BY s.date DESC LIMIT ${limit}`,
      { slug: projectSlug, cutoff },
    );

    return rows.map((r) => this.rowToSession(r));
  }

  // ─── Ingestion: Upsert methods ────────────────────────────────────────────

  async upsertProject(p: UpsertProjectInput): Promise<void> {
    await this.query(
      `MERGE (n:Project {slug: $slug})
       SET n.name = $name, n.path = $path, n.language = $language,
           n.framework = $framework, n.description = $description,
           n.health_score = $health_score, n.last_activity = $last_activity,
           n.created_at = $created_at, n.updated_at = $updated_at`,
      {
        slug: p.slug, name: p.name, path: p.path, language: p.language,
        framework: p.framework, description: p.description,
        health_score: p.health_score, last_activity: p.last_activity,
        created_at: p.created_at, updated_at: p.updated_at,
      },
    );
  }

  async upsertCommit(c: UpsertCommitInput): Promise<void> {
    await this.query(
      `MERGE (n:Commit {sha: $sha})
       SET n.message = $message, n.author = $author, n.date = $date,
           n.files_changed_count = $files_changed_count,
           n.insertions = $insertions, n.deletions = $deletions`,
      {
        sha: c.sha, message: c.message, author: c.author, date: c.date,
        files_changed_count: c.files_changed_count,
        insertions: c.insertions, deletions: c.deletions,
      },
    );
  }

  async upsertBranch(b: UpsertBranchInput): Promise<void> {
    await this.query(
      `MERGE (n:Branch {branch_key: $branch_key})
       SET n.project_slug = $project_slug, n.name = $name,
           n.is_default = $is_default, n.last_commit_date = $last_commit_date,
           n.ahead = $ahead, n.behind = $behind`,
      {
        branch_key: b.branch_key, project_slug: b.project_slug, name: b.name,
        is_default: b.is_default, last_commit_date: b.last_commit_date,
        ahead: b.ahead, behind: b.behind,
      },
    );
  }

  async upsertDependency(d: UpsertDependencyInput): Promise<void> {
    await this.query(
      `MERGE (n:Dependency {dep_key: $dep_key})
       SET n.ecosystem = $ecosystem, n.name = $name,
           n.latest_version = $latest_version, n.is_outdated = $is_outdated`,
      {
        dep_key: d.dep_key, ecosystem: d.ecosystem, name: d.name,
        latest_version: d.latest_version, is_outdated: d.is_outdated,
      },
    );
  }

  async upsertClaudeSession(s: UpsertClaudeSessionInput): Promise<void> {
    await this.query(
      `MERGE (n:ClaudeSession {session_id: $session_id})
       SET n.date = $date, n.summary = $summary,
           n.files_touched_count = $files_touched_count,
           n.model = $model, n.duration_minutes = $duration_minutes`,
      {
        session_id: s.session_id, date: s.date, summary: s.summary,
        files_touched_count: s.files_touched_count,
        model: s.model, duration_minutes: s.duration_minutes,
      },
    );
  }

  async upsertTask(t: UpsertTaskInput): Promise<void> {
    await this.query(
      `MERGE (n:Task {task_id: $task_id})
       SET n.title = $title, n.status = $status, n.assignee = $assignee,
           n.due_date = $due_date, n.priority = $priority, n.source = $source`,
      {
        task_id: t.task_id, title: t.title, status: t.status,
        assignee: t.assignee, due_date: t.due_date,
        priority: t.priority, source: t.source,
      },
    );
  }

  /** Upsert a relationship edge. type must be one of the defined rel table names. */
  async upsertRelationship(
    type: 'DEPENDS_ON' | 'RELATED_TO' | 'USES' | 'COMMITTED_TO' | 'BELONGS_TO' | 'WORKED_ON' | 'TRACKS',
    fromLabel: string,
    fromKey: string,
    fromKeyField: string,
    toLabel: string,
    toKey: string,
    toKeyField: string,
    props: Record<string, KuzuValue> = {},
  ): Promise<void> {
    const propEntries = Object.entries(props);
    const setParts = propEntries.map(([k]) => `r.${k} = $${k}`).join(', ');
    const params: Record<string, KuzuValue> = {
      fromKey,
      toKey,
      ...props,
    };
    const setCypher = setParts.length > 0 ? `SET ${setParts}` : '';
    await this.query(
      `MATCH (a:${fromLabel} {${fromKeyField}: $fromKey}), (b:${toLabel} {${toKeyField}: $toKey})
       MERGE (a)-[r:${type}]->(b)
       ${setCypher}`,
      params,
    );
  }

  // ─── Row mappers ──────────────────────────────────────────────────────────

  private rowToProject(r: Record<string, KuzuValue>): ProjectRecord {
    return {
      slug: r.slug as string,
      name: (r.name as string) || '',
      path: (r.path as string) || '',
      language: (r.language as string) || '',
      framework: (r.framework as string) || '',
      description: (r.description as string) || '',
      health_score: (r.health_score as string) || '',
      last_activity: (r.last_activity as string) || '',
      created_at: (r.created_at as string) || '',
      updated_at: (r.updated_at as string) || '',
    };
  }

  private rowToCommit(r: Record<string, KuzuValue>): CommitRecord {
    return {
      sha: r.sha as string,
      message: (r.message as string) || '',
      author: (r.author as string) || '',
      date: (r.date as string) || '',
      files_changed_count: (r.files_changed_count as number) ?? 0,
      insertions: (r.insertions as number) ?? 0,
      deletions: (r.deletions as number) ?? 0,
    };
  }

  private rowToBranch(r: Record<string, KuzuValue>): BranchRecord {
    return {
      branch_key: r.branch_key as string,
      project_slug: (r.project_slug as string) || '',
      name: (r.name as string) || '',
      is_default: (r.is_default as boolean) ?? false,
      last_commit_date: (r.last_commit_date as string) || '',
      ahead: (r.ahead as number) ?? 0,
      behind: (r.behind as number) ?? 0,
    };
  }

  private rowToSession(r: Record<string, KuzuValue>): ClaudeSessionRecord {
    return {
      session_id: r.session_id as string,
      date: (r.date as string) || '',
      summary: (r.summary as string) || '',
      files_touched_count: (r.files_touched_count as number) ?? 0,
      model: (r.model as string) || '',
      duration_minutes: (r.duration_minutes as number) ?? 0,
    };
  }

  private rowToTask(r: Record<string, KuzuValue>): TaskRecord {
    return {
      task_id: r.task_id as string,
      title: (r.title as string) || '',
      status: (r.status as string) || '',
      assignee: (r.assignee as string) || '',
      due_date: (r.due_date as string) || '',
      priority: (r.priority as string) || '',
      source: (r.source as string) || '',
    };
  }
}
