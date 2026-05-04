// One-off: re-register the global Instance node in the registry. Used after
// wiping the global DB to restore the entry the dashboard's /api/instances
// reads from. Safe to re-run — uses MERGE.
import kuzu from 'kuzu';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

(async () => {
  const dbPath = resolve(homedir(), '.brainifai', 'global', 'data', 'kuzu');
  const db = new kuzu.Database(dbPath, 0, true, false);
  const conn = new kuzu.Connection(db);
  try {
    await conn.query(`CREATE NODE TABLE IF NOT EXISTS Instance (
      name STRING, type STRING, description STRING, path STRING,
      parent STRING, status STRING DEFAULT 'active',
      created_at STRING, updated_at STRING,
      PRIMARY KEY (name))`);
    await conn.query(`CREATE REL TABLE IF NOT EXISTS PARENT_OF (FROM Instance TO Instance)`);
    const now = new Date().toISOString();
    const ps = await conn.prepare(`
      MERGE (g:Instance {name: $name})
      SET g.type = $type, g.description = $description, g.path = $path,
          g.parent = '', g.status = 'active',
          g.created_at = $now, g.updated_at = $now
    `);
    await conn.execute(ps, {
      name: 'global', type: 'general',
      description: 'Personal knowledge graph aggregating activity from Slack, GitHub, ClickUp, Apple Calendar, and Claude Code.',
      path: resolve(homedir(), '.brainifai'),
      now,
    });
    const check = await conn.query('MATCH (n:Instance) RETURN n.name AS name, n.type AS type, n.path AS path');
    const rows = await (Array.isArray(check) ? check[0] : check).getAll();
    console.log('Instances in registry:', JSON.stringify(rows, null, 2));
  } finally {
    await conn.close();
    await db.close();
  }
})();
