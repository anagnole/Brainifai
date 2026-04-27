// ─── Maintenance pass registry + runner ─────────────────────────────────────
// Each maintenance pass is a module exporting a `MaintenancePass` object.
// `runMaintenance` looks them up by name, invokes them under a per-pass timeout,
// and writes a MaintenanceRun node to the graph for observability.
//
// Passes acquire the engine's write lock themselves where they mutate. The
// runner only orchestrates and records.

import { ulid } from 'ulid';
import type { GraphEngineInstance } from '../instance.js';
import { logger } from '../../shared/logger.js';
import { tierRecomputePass } from './tier-recompute.js';
import { aliasConfirmPass } from './alias-confirm.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type MaintenanceTrigger = 'cron' | 'manual' | 'threshold';

export interface MaintenancePass {
  /** Stable name used in MaintenancePolicy and runMaintenance(). */
  name: string;
  /** Default cadence (informational — actual scheduling is the caller's job). */
  cadence: 'nightly' | 'weekly' | 'monthly';
  /**
   * Run the pass. Returns a small JSON-serializable stats object for logging.
   * MUST NOT throw — surface errors via the `errors` field instead.
   */
  run(engine: GraphEngineInstance, config?: Record<string, unknown>): Promise<PassStats>;
}

export interface PassStats {
  /** Was the pass effectively a no-op (zero items processed)? */
  noop?: boolean;
  /** Free-form metric counters (items_updated, llm_calls, etc.). */
  [key: string]: unknown;
}

export interface RunOptions {
  /** Per-pass timeout in ms. Default 5 min. */
  passTimeoutMs?: number;
  /** Why we ran. Recorded on MaintenanceRun. Default 'manual'. */
  trigger?: MaintenanceTrigger;
}

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  trigger: MaintenanceTrigger;
  passes: Array<{ name: string; ok: boolean; durationMs: number; stats: PassStats; error?: string }>;
}

// ─── Registry ───────────────────────────────────────────────────────────────

const registry = new Map<string, MaintenancePass>();

function register(pass: MaintenancePass): void {
  registry.set(pass.name, pass);
}

// Built-in passes. Add new ones here as they're implemented.
register(tierRecomputePass);
register(aliasConfirmPass);

export function getPass(name: string): MaintenancePass | undefined {
  return registry.get(name);
}

export function listPasses(): string[] {
  return [...registry.keys()];
}

/** Test-only: register a pass at runtime. Not exported from index.ts. */
export function _registerForTesting(pass: MaintenancePass): void {
  register(pass);
}

/** Test-only: clear extras added via _registerForTesting. */
export function _resetRegistryForTesting(): void {
  registry.clear();
  register(tierRecomputePass);
  register(aliasConfirmPass);
}

// ─── Runner ─────────────────────────────────────────────────────────────────

const DEFAULT_PASS_TIMEOUT_MS = 5 * 60 * 1000;

export async function runMaintenance(
  engine: GraphEngineInstance,
  passNames: string[],
  options: RunOptions = {},
): Promise<RunReport> {
  const trigger = options.trigger ?? 'manual';
  const timeout = options.passTimeoutMs ?? DEFAULT_PASS_TIMEOUT_MS;
  const runId = ulid();
  const startedAt = new Date().toISOString();

  const passes: RunReport['passes'] = [];
  for (const name of passNames) {
    const pass = registry.get(name);
    if (!pass) {
      passes.push({ name, ok: false, durationMs: 0, stats: {}, error: 'unknown pass' });
      logger.warn({ pass: name }, 'maintenance: unknown pass — skipping');
      continue;
    }
    const t0 = Date.now();
    try {
      const stats = await withTimeout(pass.run(engine), timeout, `pass "${name}" timed out`);
      passes.push({ name, ok: true, durationMs: Date.now() - t0, stats });
      logger.info({ pass: name, durationMs: Date.now() - t0, stats }, 'maintenance: pass complete');
    } catch (err) {
      passes.push({
        name,
        ok: false,
        durationMs: Date.now() - t0,
        stats: {},
        error: (err as Error).message,
      });
      logger.error({ pass: name, err }, 'maintenance: pass failed');
    }
  }

  const finishedAt = new Date().toISOString();
  await recordRun(engine, { runId, startedAt, finishedAt, trigger, passes }).catch((err) => {
    logger.warn({ err }, 'maintenance: failed to record MaintenanceRun (non-fatal)');
  });

  return { runId, startedAt, finishedAt, trigger, passes };
}

// ─── MaintenanceRun persistence ─────────────────────────────────────────────

async function recordRun(engine: GraphEngineInstance, report: RunReport): Promise<void> {
  const conn = engine.getConnection();
  const ps = await conn.prepare(`
    CREATE (r:MaintenanceRun {
      id: $id,
      started_at: $started_at,
      finished_at: $finished_at,
      stats: $stats,
      trigger: $trigger
    })
  `);
  const stats = JSON.stringify({
    passes: report.passes.map((p) => ({
      name: p.name, ok: p.ok, durationMs: p.durationMs, stats: p.stats,
      ...(p.error ? { error: p.error } : {}),
    })),
  });
  await conn.execute(ps, {
    id: report.runId,
    started_at: report.startedAt,
    finished_at: report.finishedAt,
    stats,
    trigger: report.trigger,
  } as never);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
