// ─── GraphEngineInstance ────────────────────────────────────────────────────
// Wraps a Kuzu database + connection + SchemaSpec. Runs DDL at initialize().
// Callers use this as the entrypoint for all engine operations.

import kuzu from 'kuzu';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../shared/logger.js';
import { buildDdl } from './schema-builder.js';
import type { SchemaSpec } from './types.js';

export interface GraphEngineConfig {
  spec: SchemaSpec;
  dbPath: string;
  readOnly?: boolean;
}

export class GraphEngineInstance {
  readonly spec: SchemaSpec;
  readonly dbPath: string;
  readonly lockPath: string;
  private readonly readOnly: boolean;
  private db: InstanceType<typeof kuzu.Database>;
  private conn: InstanceType<typeof kuzu.Connection>;
  private initialized = false;

  constructor(config: GraphEngineConfig) {
    this.spec = config.spec;
    this.dbPath = resolve(config.dbPath);
    this.readOnly = config.readOnly ?? false;
    this.lockPath = resolve(dirname(this.dbPath), 'write.lock');

    const parent = dirname(this.dbPath);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

    this.db = new kuzu.Database(this.dbPath, 0, true, this.readOnly);
    this.conn = new kuzu.Connection(this.db);
  }

  /**
   * Run schema DDL: node tables, rel tables, migrations (additive), then FTS
   * indexes. Idempotent — all statements use IF NOT EXISTS, migrations swallow
   * duplicate-column errors.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.readOnly) {
      this.initialized = true;
      return;
    }

    const ddl = buildDdl(this.spec);

    for (const stmt of ddl.nodeTables) await this.exec(stmt);
    for (const stmt of ddl.relTables) await this.exec(stmt);

    // Migrations: additive ALTER statements. Safe to re-run — ignore errors.
    for (const stmt of ddl.migrations) {
      try {
        await this.exec(stmt);
      } catch (err) {
        // Column already exists / table not yet created on this spec version — tolerate.
        logger.debug({ stmt, err: (err as Error).message }, 'migration skipped');
      }
    }

    // FTS indexes last — they depend on tables and data shape.
    for (const stmt of ddl.ftsIndexes) {
      try {
        await this.exec(stmt);
      } catch (err) {
        // Index may already exist; ignore.
        logger.debug({ stmt, err: (err as Error).message }, 'FTS index creation skipped');
      }
    }

    this.initialized = true;
    logger.info(
      { dbPath: this.dbPath, typeName: this.spec.typeName },
      'GraphEngineInstance initialized',
    );
  }

  getConnection(): InstanceType<typeof kuzu.Connection> {
    return this.conn;
  }

  /** Rebuild FTS indexes (drop + recreate). Run periodically by maintenance. */
  async rebuildFtsIndexes(): Promise<void> {
    const ddl = buildDdl(this.spec);
    for (const stmt of ddl.ftsDrops) {
      try { await this.exec(stmt); } catch { /* not present yet */ }
    }
    for (const stmt of ddl.ftsIndexes) {
      try { await this.exec(stmt); } catch (err) {
        logger.warn({ stmt, err: (err as Error).message }, 'FTS rebuild failed');
      }
    }
  }

  async close(): Promise<void> {
    try { await this.conn.close(); } catch { /* already closed */ }
    try { await this.db.close(); } catch { /* already closed */ }
  }

  /**
   * Execute a DDL or DML statement without parameters. Reserved for internal
   * use — worker/write-path use prepared statements via the conn directly.
   */
  private async exec(cypher: string): Promise<void> {
    const result = await this.conn.query(cypher);
    // Drain multi-statement results so handles don't leak
    if (Array.isArray(result)) {
      for (const r of result) await r.getAll().catch(() => []);
    } else {
      await result.getAll().catch(() => []);
    }
  }
}
