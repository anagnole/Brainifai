import kuzu from 'kuzu';
import { resolve } from 'path';
import { GLOBAL_BRAINIFAI_PATH } from './resolve.js';
import type { InstanceRegistryEntry } from './types.js';
import { emitInstanceRegistered, emitInstanceUpdated, emitInstanceRemoved } from '../event-bus/helpers.js';

/** Ensure the Instance table and PARENT_OF rel exist (idempotent) */
async function ensureSchema(conn: InstanceType<typeof kuzu.Connection>): Promise<void> {
  await conn.query(`CREATE NODE TABLE IF NOT EXISTS Instance (
    name STRING, type STRING, description STRING, path STRING,
    parent STRING, status STRING DEFAULT 'active',
    created_at STRING, updated_at STRING,
    PRIMARY KEY (name)
  )`);
  await conn.query(`CREATE REL TABLE IF NOT EXISTS PARENT_OF (FROM Instance TO Instance)`);
}

/** Open a short-lived connection to the global DB.
 *  Use readOnly=true for queries — allows concurrent access when another process holds the DB. */
async function openGlobalDb(readOnly = false): Promise<{ db: InstanceType<typeof kuzu.Database>; conn: InstanceType<typeof kuzu.Connection> }> {
  const globalDbPath = resolve(GLOBAL_BRAINIFAI_PATH, 'data', 'kuzu');
  const db = new kuzu.Database(globalDbPath, 0, true, readOnly);
  let conn: InstanceType<typeof kuzu.Connection>;
  try {
    conn = new kuzu.Connection(db);
  } catch (err) {
    db.close(); // prevent dangling native handle / unhandled rejection
    throw err;
  }
  return { db, conn: conn! };
}

/** Parse a row from a Kuzu Instance query into an InstanceRegistryEntry */
function rowToEntry(r: Record<string, unknown>): InstanceRegistryEntry {
  return {
    name: r['n.name'] as string,
    type: r['n.type'] as string,
    description: r['n.description'] as string,
    path: r['n.path'] as string,
    parent: (r['n.parent'] as string) || null,
    status: (r['n.status'] as InstanceRegistryEntry['status']) ?? 'active',
    createdAt: r['n.created_at'] as string,
    updatedAt: r['n.updated_at'] as string,
  };
}

/** Register a child instance in the global graph */
export async function registerWithGlobal(
  name: string,
  type: string,
  description: string,
  instancePath: string,
  now: string,
): Promise<void> {
  const { db, conn } = await openGlobalDb();

  try {
    await ensureSchema(conn);

    // Upsert child instance node
    const cypher = `
      MERGE (n:Instance {name: $name})
      ON CREATE SET n.type = $type, n.description = $description,
                    n.path = $path, n.parent = $parent,
                    n.status = 'active',
                    n.created_at = $created_at, n.updated_at = $updated_at
      ON MATCH SET  n.type = $type, n.description = $description,
                    n.path = $path, n.parent = $parent,
                    n.status = 'active',
                    n.updated_at = $updated_at
    `;
    const ps = await conn.prepare(cypher);
    await conn.execute(ps, {
      name, type, description,
      path: instancePath,
      parent: 'global',
      created_at: now,
      updated_at: now,
    });

    // Ensure global node exists
    const globalPs = await conn.prepare(`
      MERGE (g:Instance {name: $name})
      ON CREATE SET g.type = $type,
                    g.description = $description,
                    g.path = $path,
                    g.status = 'active',
                    g.created_at = $now,
                    g.updated_at = $now
    `);
    await conn.execute(globalPs, {
      name: 'global',
      type: 'general',
      description: 'Global Brainifai instance',
      path: GLOBAL_BRAINIFAI_PATH,
      now,
    });

    // Create PARENT_OF edge (use MERGE to avoid duplicates)
    const edgePs = await conn.prepare(`
      MATCH (parent:Instance {name: $parent}), (child:Instance {name: $child})
      MERGE (parent)-[:PARENT_OF]->(child)
    `);
    await conn.execute(edgePs, { parent: 'global', child: name });
  } finally {
    await conn.close();
    await db.close();
  }

  await emitInstanceRegistered(name, { name, type, description, path: instancePath, parent: 'global' });
}

/** Mark an instance as removed in the global registry */
export async function unregisterInstance(name: string): Promise<boolean> {
  const { db, conn } = await openGlobalDb();

  try {
    await ensureSchema(conn);
    const ps = await conn.prepare(`
      MATCH (n:Instance {name: $name})
      SET n.status = 'removed', n.updated_at = $updated_at
    `);
    await conn.execute(ps, { name, updated_at: new Date().toISOString() });
    await emitInstanceRemoved(name, { name });
    return true;
  } catch {
    return false;
  } finally {
    await conn.close();
    await db.close();
  }
}

/** Sync a child instance's description to the global registry */
export async function syncDescription(name: string, description: string): Promise<void> {
  const { db, conn } = await openGlobalDb();

  try {
    await ensureSchema(conn);
    const ps = await conn.prepare(`
      MATCH (n:Instance {name: $name})
      SET n.description = $description, n.updated_at = $updated_at
    `);
    await conn.execute(ps, { name, description, updated_at: new Date().toISOString() });
  } finally {
    await conn.close();
    await db.close();
  }

  await emitInstanceUpdated(name, { name, fields: { description } });
}

/** List all registered instances from global graph */
export async function listInstances(opts?: { status?: string }): Promise<InstanceRegistryEntry[]> {
  const { db, conn } = await openGlobalDb(true); // read-only: compatible with concurrent readers

  try {
    let result;
    if (opts?.status) {
      const ps = await conn.prepare('MATCH (n:Instance) WHERE n.status = $status RETURN n.*');
      result = await conn.execute(ps, { status: opts.status });
    } else {
      result = await conn.query('MATCH (n:Instance) RETURN n.*');
    }
    const res = Array.isArray(result) ? result[0] : result;
    const rows = await res.getAll() as Record<string, unknown>[];
    return rows.map(rowToEntry);
  } catch {
    return []; // table doesn't exist yet or read error
  } finally {
    await conn.close();
    await db.close();
  }
}

/** Get a single instance by name */
export async function getInstanceByName(name: string): Promise<InstanceRegistryEntry | null> {
  const { db, conn } = await openGlobalDb(true); // read-only

  try {
    const ps = await conn.prepare('MATCH (n:Instance {name: $name}) RETURN n.*');
    const raw = await conn.execute(ps, { name });
    const result = Array.isArray(raw) ? raw[0] : raw;
    const rows = await result.getAll() as Record<string, unknown>[];
    if (rows.length === 0) return null;
    return rowToEntry(rows[0]);
  } catch {
    return null;
  } finally {
    await conn.close();
    await db.close();
  }
}

/** List instances filtered by type */
export async function findInstancesByType(type: string): Promise<InstanceRegistryEntry[]> {
  const all = await listInstances({ status: 'active' });
  return all.filter(i => i.type === type);
}

/** Search instances by description using FTS */
export async function searchInstances(query: string): Promise<InstanceRegistryEntry[]> {
  const { db, conn } = await openGlobalDb(true); // read-only

  try {
    const ps = await conn.prepare(`
      CALL QUERY_FTS_INDEX('Instance', 'instance_fts', $query, top_k := 10)
      RETURN node.name AS name, node.type AS type, node.description AS description,
             node.path AS path, node.parent AS parent, node.status AS status,
             node.created_at AS created_at, node.updated_at AS updated_at, score
      ORDER BY score DESC
    `);
    const raw = await conn.execute(ps, { query });
    const result = Array.isArray(raw) ? raw[0] : raw;
    const rows = await result.getAll() as Record<string, unknown>[];

    return rows.map((r) => ({
      name: r['name'] as string,
      type: r['type'] as string,
      description: r['description'] as string,
      path: r['path'] as string,
      parent: (r['parent'] as string) || null,
      status: (r['status'] as InstanceRegistryEntry['status']) ?? 'active',
      createdAt: r['created_at'] as string,
      updatedAt: r['updated_at'] as string,
    }));
  } catch {
    // FTS index may not exist yet (no data) — fall back to empty
    return [];
  } finally {
    await conn.close();
    await db.close();
  }
}
