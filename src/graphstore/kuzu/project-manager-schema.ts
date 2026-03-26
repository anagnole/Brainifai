/**
 * Project Manager Kuzu DDL — node tables, relationship tables, and FTS indexes
 * for project portfolio management.
 *
 * Tracks project health, cross-project dependencies, commit activity,
 * Claude session history, and task progress across all repositories.
 */

// ─── Node Tables (6) ──────────────────────────────────────────────────────────

export const PM_NODE_TABLES = [
  `CREATE NODE TABLE IF NOT EXISTS Project (
    slug STRING,
    name STRING,
    path STRING,
    language STRING,
    framework STRING,
    description STRING,
    health_score STRING,
    last_activity STRING,
    created_at STRING,
    updated_at STRING,
    PRIMARY KEY (slug)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Commit (
    sha STRING,
    message STRING,
    author STRING,
    date STRING,
    files_changed_count INT64,
    insertions INT64,
    deletions INT64,
    PRIMARY KEY (sha)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Branch (
    branch_key STRING,
    project_slug STRING,
    name STRING,
    is_default BOOLEAN,
    last_commit_date STRING,
    ahead INT64,
    behind INT64,
    PRIMARY KEY (branch_key)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Dependency (
    dep_key STRING,
    ecosystem STRING,
    name STRING,
    latest_version STRING,
    is_outdated BOOLEAN,
    PRIMARY KEY (dep_key)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS ClaudeSession (
    session_id STRING,
    date STRING,
    summary STRING,
    files_touched_count INT64,
    model STRING,
    duration_minutes INT64,
    PRIMARY KEY (session_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Task (
    task_id STRING,
    title STRING,
    status STRING,
    assignee STRING,
    due_date STRING,
    priority STRING,
    source STRING,
    PRIMARY KEY (task_id)
  )`,
];

// ─── Relationship Tables (7) ──────────────────────────────────────────────────

export const PM_REL_TABLES = [
  // Project cross-references
  `CREATE REL TABLE IF NOT EXISTS DEPENDS_ON (
    FROM Project TO Project,
    dependency_type STRING,
    description STRING
  )`,

  `CREATE REL TABLE IF NOT EXISTS RELATED_TO (
    FROM Project TO Project,
    relation_type STRING,
    confidence STRING
  )`,

  // Project → Dependency
  `CREATE REL TABLE IF NOT EXISTS USES (
    FROM Project TO Dependency,
    version STRING,
    is_dev BOOLEAN,
    lock_version STRING
  )`,

  // Commit → Project
  `CREATE REL TABLE IF NOT EXISTS COMMITTED_TO (
    FROM Commit TO Project,
    branch_name STRING
  )`,

  // Branch → Project
  `CREATE REL TABLE IF NOT EXISTS BELONGS_TO (FROM Branch TO Project)`,

  // ClaudeSession → Project
  `CREATE REL TABLE IF NOT EXISTS WORKED_ON (
    FROM ClaudeSession TO Project,
    files_touched STRING,
    summary STRING
  )`,

  // Task → Project
  `CREATE REL TABLE IF NOT EXISTS TRACKS (FROM Task TO Project)`,
];

// ─── FTS Indexes (5) ──────────────────────────────────────────────────────────

export const PM_FTS_INDEXES = [
  `CALL CREATE_FTS_INDEX('Project', 'project_fts', ['name', 'description', 'framework'])`,
  `CALL CREATE_FTS_INDEX('Commit', 'commit_fts', ['message', 'author'])`,
  `CALL CREATE_FTS_INDEX('Dependency', 'dependency_fts', ['name'])`,
  `CALL CREATE_FTS_INDEX('ClaudeSession', 'claude_session_fts', ['summary'])`,
  `CALL CREATE_FTS_INDEX('Task', 'task_fts', ['title', 'assignee'])`,
];

export const PM_FTS_DROP = [
  `CALL DROP_FTS_INDEX('Project', 'project_fts')`,
  `CALL DROP_FTS_INDEX('Commit', 'commit_fts')`,
  `CALL DROP_FTS_INDEX('Dependency', 'dependency_fts')`,
  `CALL DROP_FTS_INDEX('ClaudeSession', 'claude_session_fts')`,
  `CALL DROP_FTS_INDEX('Task', 'task_fts')`,
];

// ─── Schema lifecycle functions ───────────────────────────────────────────────

export async function createProjectManagerSchema(conn: { query: (stmt: string) => Promise<unknown> }): Promise<void> {
  for (const stmt of PM_NODE_TABLES) await conn.query(stmt);
  for (const stmt of PM_REL_TABLES) await conn.query(stmt);
}

export async function createProjectManagerFtsIndexes(conn: { query: (stmt: string) => Promise<unknown> }): Promise<void> {
  for (const stmt of PM_FTS_INDEXES) {
    try { await conn.query(stmt); } catch { /* table may be empty */ }
  }
}

export async function rebuildProjectManagerFtsIndexes(conn: { query: (stmt: string) => Promise<unknown> }): Promise<void> {
  for (const stmt of PM_FTS_DROP) {
    try { await conn.query(stmt); } catch { /* index may not exist */ }
  }
  await createProjectManagerFtsIndexes(conn);
}
