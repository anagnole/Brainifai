/**
 * Researcher Schema integration tests.
 *
 * Runs against a temp Kuzu DB to verify DDL execution for node tables,
 * relationship tables, and FTS indexes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import kuzu from 'kuzu';
import type { QueryResult } from 'kuzu';
import {
  RESEARCHER_NODE_TABLES,
  RESEARCHER_REL_TABLES,
  createResearcherSchema,
  createResearcherFtsIndexes,
  rebuildResearcherFtsIndexes,
} from './researcher-schema.js';

/** Unwrap Kuzu query result (may be single or array). */
function qr(result: QueryResult | QueryResult[]): QueryResult {
  return Array.isArray(result) ? result[0] : result;
}

describe('Researcher Schema', () => {
  let db: InstanceType<typeof kuzu.Database>;
  let conn: InstanceType<typeof kuzu.Connection>;

  beforeAll(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'researcher-schema-test-'));
    const dbPath = join(tmpDir, 'test.db');
    db = new kuzu.Database(dbPath);
    conn = new kuzu.Connection(db);

    // Load FTS extension (required before creating FTS indexes)
    await conn.query('LOAD EXTENSION fts');

    // The researcher schema has REL tables that reference Activity,
    // so we need the base Activity node table first.
    await conn.query(`CREATE NODE TABLE IF NOT EXISTS Activity (
      source_id STRING,
      source STRING,
      timestamp STRING,
      kind STRING,
      snippet STRING,
      url STRING,
      thread_ts STRING,
      parent_source_id STRING,
      message_count INT64,
      created_at STRING,
      updated_at STRING,
      valid_from STRING,
      PRIMARY KEY (source_id)
    )`);
  }, 30_000);

  afterAll(async () => {
    await conn.close();
    await db.close();
  });

  // ── Node tables ────────────────────────────────────────────────────────────

  it('creates all 4 node tables without error', async () => {
    // createResearcherSchema runs all DDL
    await expect(createResearcherSchema(conn)).resolves.not.toThrow();
  });

  it('can insert into ResearchEntity', async () => {
    await conn.query(`CREATE (n:ResearchEntity {
      entity_key: 'test:e1', name: 'Test Entity', type: 'company',
      domain: 'ai', url: '', description: 'A test entity',
      created_at: '2025-01-01', updated_at: '2025-01-01'
    })`);

    const result = await conn.query(
      `MATCH (n:ResearchEntity {entity_key: 'test:e1'}) RETURN n.name AS name`,
    );
    const rows = await qr(result).getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Test Entity');
  });

  it('can insert into ResearchEvent', async () => {
    await conn.query(`CREATE (n:ResearchEvent {
      event_key: 'test:ev1', title: 'Test Event', date: '2025-01-15',
      description: 'Something happened', significance: 'high',
      event_type: 'release', created_at: '2025-01-15', updated_at: '2025-01-15'
    })`);

    const result = await conn.query(
      `MATCH (n:ResearchEvent {event_key: 'test:ev1'}) RETURN n.title AS title`,
    );
    const rows = await qr(result).getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Test Event');
  });

  it('can insert into ResearchMetric', async () => {
    await conn.query(`CREATE (n:ResearchMetric {
      metric_key: 'test:m1', name: 'Revenue', domain: 'ai',
      unit: 'USD', created_at: '2025-01-01', updated_at: '2025-01-01'
    })`);

    const result = await conn.query(
      `MATCH (n:ResearchMetric {metric_key: 'test:m1'}) RETURN n.name AS name`,
    );
    const rows = await qr(result).getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Revenue');
  });

  it('can insert into ResearchTrend', async () => {
    await conn.query(`CREATE (n:ResearchTrend {
      trend_key: 'test:t1', name: 'AI Safety', first_seen: '2025-01-01',
      last_seen: '2025-01-15', domain: 'ai',
      created_at: '2025-01-01', updated_at: '2025-01-15'
    })`);

    const result = await conn.query(
      `MATCH (n:ResearchTrend {trend_key: 'test:t1'}) RETURN n.name AS name`,
    );
    const rows = await qr(result).getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('AI Safety');
  });

  // ── Relationship tables ─────────────────────────────────────────────────

  it('creates all 6 relationship tables without error', async () => {
    // Relationships are already created by createResearcherSchema above.
    // Verify by creating actual edges.

    // INVOLVED_IN: Entity → Event
    await conn.query(`
      MATCH (e:ResearchEntity {entity_key: 'test:e1'}), (ev:ResearchEvent {event_key: 'test:ev1'})
      CREATE (e)-[:INVOLVED_IN {role: 'subject'}]->(ev)
    `);

    const involvedResult = await conn.query(`
      MATCH (e:ResearchEntity)-[r:INVOLVED_IN]->(ev:ResearchEvent)
      RETURN r.role AS role
    `);
    const involvedRows = await qr(involvedResult).getAll();
    expect(involvedRows).toHaveLength(1);
    expect(involvedRows[0].role).toBe('subject');
  });

  it('supports ENTITY_RELATED_TO relationship', async () => {
    // Create a second entity
    await conn.query(`CREATE (n:ResearchEntity {
      entity_key: 'test:e2', name: 'Another Entity', type: 'product',
      domain: 'ai', url: '', description: 'Related entity',
      created_at: '2025-01-01', updated_at: '2025-01-01'
    })`);

    await conn.query(`
      MATCH (a:ResearchEntity {entity_key: 'test:e1'}), (b:ResearchEntity {entity_key: 'test:e2'})
      CREATE (a)-[:ENTITY_RELATED_TO {relation_type: 'competitor', confidence: '0.9'}]->(b)
    `);

    const result = await conn.query(`
      MATCH (a:ResearchEntity)-[r:ENTITY_RELATED_TO]->(b:ResearchEntity)
      RETURN r.relation_type AS rel_type
    `);
    const rows = await qr(result).getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].rel_type).toBe('competitor');
  });

  it('supports MEASURED_BY relationship', async () => {
    await conn.query(`
      MATCH (e:ResearchEntity {entity_key: 'test:e1'}), (m:ResearchMetric {metric_key: 'test:m1'})
      CREATE (e)-[:MEASURED_BY {value: '1000000', date: '2025-01-15'}]->(m)
    `);

    const result = await conn.query(`
      MATCH (e:ResearchEntity)-[r:MEASURED_BY]->(m:ResearchMetric)
      RETURN r.value AS value
    `);
    const rows = await qr(result).getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('1000000');
  });

  it('supports PART_OF_TREND relationship', async () => {
    await conn.query(`
      MATCH (ev:ResearchEvent {event_key: 'test:ev1'}), (t:ResearchTrend {trend_key: 'test:t1'})
      CREATE (ev)-[:PART_OF_TREND]->(t)
    `);

    const result = await conn.query(`
      MATCH (ev:ResearchEvent)-[:PART_OF_TREND]->(t:ResearchTrend)
      RETURN t.name AS trend_name
    `);
    const rows = await qr(result).getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].trend_name).toBe('AI Safety');
  });

  it('supports ENTITY_MENTIONED_IN cross-schema link', async () => {
    // Create an Activity node first
    await conn.query(`CREATE (a:Activity {
      source_id: 'twitter:feed:12345', source: 'twitter',
      timestamp: '2025-01-15T00:00:00Z', kind: 'tweet',
      snippet: 'Test activity', url: '', thread_ts: '',
      parent_source_id: '', message_count: 0,
      created_at: '2025-01-15', updated_at: '2025-01-15', valid_from: ''
    })`);

    await conn.query(`
      MATCH (e:ResearchEntity {entity_key: 'test:e1'}), (a:Activity {source_id: 'twitter:feed:12345'})
      CREATE (e)-[:ENTITY_MENTIONED_IN {extraction_date: '2025-01-15'}]->(a)
    `);

    const result = await conn.query(`
      MATCH (e:ResearchEntity)-[r:ENTITY_MENTIONED_IN]->(a:Activity)
      RETURN r.extraction_date AS extraction_date
    `);
    const rows = await qr(result).getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].extraction_date).toBe('2025-01-15');
  });

  // ── FTS indexes ──────────────────────────────────────────────────────────

  it('creates FTS indexes without error', async () => {
    await expect(createResearcherFtsIndexes(conn)).resolves.not.toThrow();
  }, 30_000);

  it('rebuild drops and recreates FTS indexes', async () => {
    // Should not throw even when called multiple times
    await expect(rebuildResearcherFtsIndexes(conn)).resolves.not.toThrow();
    await expect(rebuildResearcherFtsIndexes(conn)).resolves.not.toThrow();
  }, 30_000);

  it('FTS search returns results after rebuild', async () => {
    await rebuildResearcherFtsIndexes(conn);

    const result = await conn.query(
      `CALL QUERY_FTS_INDEX('ResearchEntity', 'research_entity_fts', 'Test Entity')
       RETURN node.name AS name, score
       ORDER BY score DESC`,
    );
    const rows = await qr(result).getAll();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].name).toBe('Test Entity');
  }, 30_000);
});
