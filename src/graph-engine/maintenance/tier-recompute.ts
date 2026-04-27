// ─── tier-recompute maintenance pass ────────────────────────────────────────
// Recomputes Atom.tier based on age and access count. See docs/design/graph-engine.md §8.
//
//   hot   — age < hotMaxDays  OR access_count >= hotMinAccess
//   warm  — age < warmMaxDays OR access_count >= warmMinAccess
//   cold  — everything else
//
// Skipped silently when SchemaSpec.agingEnabled is false (the column doesn't exist).
//
// Holds the engine's write lock for the duration of the UPDATE. Idempotent —
// running twice is harmless. O(N) over Atom; on a 100k-atom graph still
// completes in <1s on Kuzu's columnar engine.

import type { GraphEngineInstance } from '../instance.js';
import type { MaintenancePass, PassStats } from './index.js';
import { withLock } from '../lock.js';
import { logger } from '../../shared/logger.js';

interface Config {
  hotMaxDays?: number;
  hotMinAccess?: number;
  warmMaxDays?: number;
  warmMinAccess?: number;
}

const DEFAULTS: Required<Config> = {
  hotMaxDays:   7,
  hotMinAccess: 3,
  warmMaxDays:  90,
  warmMinAccess: 2,
};

export const tierRecomputePass: MaintenancePass = {
  name: 'tier-recompute',
  cadence: 'nightly',

  async run(engine: GraphEngineInstance, rawConfig?: Record<string, unknown>): Promise<PassStats> {
    if (!engine.spec.agingEnabled) {
      logger.debug({ spec: engine.spec.typeName }, 'tier-recompute: skipped (agingEnabled=false)');
      return { noop: true, reason: 'aging disabled' };
    }

    const cfg = { ...DEFAULTS, ...(rawConfig as Config | undefined) };
    const atomTable = engine.spec.atomTableName ?? 'Atom';

    // Cutoffs: anything created after `hotCutoff` is hot, etc.
    const now = Date.now();
    const hotCutoff  = new Date(now - cfg.hotMaxDays  * 86400_000).toISOString();
    const warmCutoff = new Date(now - cfg.warmMaxDays * 86400_000).toISOString();

    return withLock(engine.lockPath, async () => {
      const conn = engine.getConnection();

      // Snapshot prior tier counts so we can report what changed.
      const before = await tierCounts(conn, atomTable);

      // The three branches are mutually exclusive — apply in cold→warm→hot
      // order so a hot-eligible atom doesn't get downgraded mid-pass by a
      // later branch that excludes it.
      const setCold = await conn.prepare(`
        MATCH (a:${atomTable})
        WHERE a.created_at < $warmCutoff AND a.access_count < $warmMinAccess
        SET a.tier = 'cold'
      `);
      await conn.execute(setCold, { warmCutoff, warmMinAccess: cfg.warmMinAccess } as never);

      const setWarm = await conn.prepare(`
        MATCH (a:${atomTable})
        WHERE (a.created_at >= $warmCutoff AND a.created_at < $hotCutoff
               AND a.access_count < $hotMinAccess)
           OR (a.created_at < $warmCutoff AND a.access_count >= $warmMinAccess
               AND a.access_count < $hotMinAccess)
        SET a.tier = 'warm'
      `);
      await conn.execute(setWarm, {
        warmCutoff, hotCutoff,
        hotMinAccess: cfg.hotMinAccess,
        warmMinAccess: cfg.warmMinAccess,
      } as never);

      const setHot = await conn.prepare(`
        MATCH (a:${atomTable})
        WHERE a.created_at >= $hotCutoff OR a.access_count >= $hotMinAccess
        SET a.tier = 'hot'
      `);
      await conn.execute(setHot, { hotCutoff, hotMinAccess: cfg.hotMinAccess } as never);

      const after = await tierCounts(conn, atomTable);

      const moved = {
        hot:  after.hot  - before.hot,
        warm: after.warm - before.warm,
        cold: after.cold - before.cold,
      };

      return {
        before, after,
        delta: moved,
        config: cfg,
      };
    });
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

async function tierCounts(conn: any, atomTable: string): Promise<{ hot: number; warm: number; cold: number }> {
  const ps = await conn.prepare(`
    MATCH (a:${atomTable})
    RETURN a.tier AS tier, count(a) AS n
  `);
  const r = await conn.execute(ps, {});
  const rows = await (Array.isArray(r) ? r[0] : r).getAll() as Array<{ tier: string; n: number | bigint }>;
  const out = { hot: 0, warm: 0, cold: 0 };
  for (const row of rows) {
    const n = typeof row.n === 'bigint' ? Number(row.n) : (row.n ?? 0);
    if (row.tier === 'hot')  out.hot  = n;
    if (row.tier === 'warm') out.warm = n;
    if (row.tier === 'cold') out.cold = n;
  }
  return out;
}
