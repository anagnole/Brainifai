/**
 * Quick verification queries against the project-manager Kuzu instance.
 * Usage: tsx src/scripts/query-project-manager.ts
 */
import kuzu from 'kuzu';
import os from 'os';
import path from 'path';

const DB_PATH = path.join(os.homedir(), 'Projects', '.brainifai', 'data', 'kuzu');

async function run(conn: kuzu.Connection, label: string, cypher: string) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`▶ ${label}`);
  console.log(`  ${cypher}`);
  console.log('─'.repeat(70));
  try {
    const raw = await conn.query(cypher);
    const qr = Array.isArray(raw) ? raw[0] : raw;
    const rows = await qr.getAll();
    if (rows.length === 0) {
      console.log('  (no results)');
    } else {
      // Print column headers from first row
      const cols = Object.keys(rows[0]);
      const colWidth = Math.max(20, Math.floor(100 / cols.length));
      const header = cols.map((c) => c.padEnd(colWidth)).join(' │ ');
      console.log('  ' + header);
      console.log('  ' + '─'.repeat(header.length));
      for (const row of rows) {
        const line = cols.map((c) => String(row[c] ?? '').padEnd(colWidth)).join(' │ ');
        console.log('  ' + line);
      }
      console.log(`\n  → ${rows.length} row(s)`);
    }
    qr.close();
  } catch (err: any) {
    console.error(`  ERROR: ${err.message}`);
  }
}

async function main() {
  console.log(`\n🔍 Querying project-manager DB at: ${DB_PATH}\n`);
  const db = new kuzu.Database(DB_PATH, 0, true /* readOnly */);
  const conn = new kuzu.Connection(db);

  // ── Q1: All projects with health scores ──────────────────────────────────
  await run(
    conn,
    'Q1 — All projects with health scores',
    'MATCH (p:Project) RETURN p.slug, p.name, p.language, p.framework, p.health_score ORDER BY p.name',
  );

  // ── Q2: DEPENDS_ON edges ─────────────────────────────────────────────────
  await run(
    conn,
    'Q2 — Cross-project DEPENDS_ON edges',
    'MATCH (a:Project)-[r:DEPENDS_ON]->(b:Project) RETURN a.name, r.dependency_type, b.name',
  );

  // ── Q3: RELATED_TO edges ─────────────────────────────────────────────────
  await run(
    conn,
    'Q3 — RELATED_TO edges',
    'MATCH (a:Project)-[r:RELATED_TO]->(b:Project) RETURN a.name, r.relation_type, b.name, r.confidence',
  );

  // ── Q4: Top shared dependencies ──────────────────────────────────────────
  await run(
    conn,
    'Q4 — Top 10 most shared dependencies (used by >1 project)',
    'MATCH (p:Project)-[:USES]->(d:Dependency) WITH d, count(p) AS usage WHERE usage > 1 RETURN d.name, d.ecosystem, usage ORDER BY usage DESC LIMIT 10',
  );

  // ── Q5: Projects with Claude sessions ────────────────────────────────────
  await run(
    conn,
    'Q5 — Projects with Claude sessions (most active first)',
    'MATCH (s:ClaudeSession)-[:WORKED_ON]->(p:Project) WITH p, count(s) AS sessions RETURN p.name, sessions ORDER BY sessions DESC',
  );

  // ── Bonus: total node counts ─────────────────────────────────────────────
  console.log(`\n${'─'.repeat(70)}`);
  console.log('▶ Bonus — Node counts per table');
  console.log('─'.repeat(70));
  for (const [label, cypher] of [
    ['Project', 'MATCH (n:Project) RETURN count(n) AS cnt'],
    ['Commit', 'MATCH (n:Commit) RETURN count(n) AS cnt'],
    ['Branch', 'MATCH (n:Branch) RETURN count(n) AS cnt'],
    ['Dependency', 'MATCH (n:Dependency) RETURN count(n) AS cnt'],
    ['ClaudeSession', 'MATCH (n:ClaudeSession) RETURN count(n) AS cnt'],
    ['Task', 'MATCH (n:Task) RETURN count(n) AS cnt'],
  ] as [string, string][]) {
    const raw = await conn.query(cypher);
    const qr = Array.isArray(raw) ? raw[0] : raw;
    const rows = await qr.getAll();
    console.log(`  ${label.padEnd(16)}: ${rows[0]?.cnt ?? 0}`);
    qr.close();
  }

  // ── Bonus: relationship counts ───────────────────────────────────────────
  console.log('');
  for (const [label, cypher] of [
    ['DEPENDS_ON', 'MATCH ()-[r:DEPENDS_ON]->() RETURN count(r) AS cnt'],
    ['USES', 'MATCH ()-[r:USES]->() RETURN count(r) AS cnt'],
    ['COMMITTED_TO', 'MATCH ()-[r:COMMITTED_TO]->() RETURN count(r) AS cnt'],
    ['BELONGS_TO', 'MATCH ()-[r:BELONGS_TO]->() RETURN count(r) AS cnt'],
    ['WORKED_ON', 'MATCH ()-[r:WORKED_ON]->() RETURN count(r) AS cnt'],
    ['TRACKS', 'MATCH ()-[r:TRACKS]->() RETURN count(r) AS cnt'],
    ['RELATED_TO', 'MATCH ()-[r:RELATED_TO]->() RETURN count(r) AS cnt'],
  ] as [string, string][]) {
    const raw = await conn.query(cypher);
    const qr = Array.isArray(raw) ? raw[0] : raw;
    const rows = await qr.getAll();
    console.log(`  ${label.padEnd(16)}: ${rows[0]?.cnt ?? 0}`);
    qr.close();
  }

  conn.close();
  db.close();
  console.log(`\n✅ Done.\n`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
