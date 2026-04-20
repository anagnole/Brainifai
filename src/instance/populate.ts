// ─── Populate script runner ─────────────────────────────────────────────────
// Executes a template's optional populate.script via tsx, streaming stdout/err
// to the user. Non-fatal on failure — init succeeds either way.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { PopulateStep } from './templates.js';
import { logger } from '../shared/logger.js';

export interface PopulateRunOptions {
  /** Absolute path to the instance (`.brainifai/<name>/`). */
  instancePath: string;
  /** Absolute path to the instance's Kuzu DB. */
  dbPath: string;
  /** Instance name. */
  instanceName: string;
  /** Repo root from which to resolve the script path. */
  repoRoot?: string;
}

export interface PopulateRunResult {
  success: boolean;
  exitCode: number | null;
  error?: string;
}

/**
 * Run a template's populate script as a tsx subprocess. Streams output to the
 * parent process. Passes context via env vars (BRAINIFAI_INSTANCE_PATH,
 * BRAINIFAI_DB_PATH, BRAINIFAI_INSTANCE_NAME).
 */
export async function runPopulateScript(
  step: PopulateStep,
  opts: PopulateRunOptions,
): Promise<PopulateRunResult> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const scriptPath = resolve(repoRoot, step.script);

  if (!existsSync(scriptPath)) {
    const error = `Populate script not found: ${scriptPath}`;
    logger.warn({ scriptPath }, error);
    return { success: false, exitCode: null, error };
  }

  logger.info({ scriptPath, instance: opts.instanceName }, 'Running populate script');

  return new Promise<PopulateRunResult>((resolve) => {
    const child = spawn('npx', ['tsx', scriptPath], {
      stdio: 'inherit',
      env: {
        ...process.env,
        BRAINIFAI_INSTANCE_PATH: opts.instancePath,
        BRAINIFAI_DB_PATH: opts.dbPath,
        BRAINIFAI_INSTANCE_NAME: opts.instanceName,
      },
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ success: true, exitCode: 0 });
      } else {
        resolve({
          success: false,
          exitCode: code,
          error: `Populate script exited with code ${code}`,
        });
      }
    });

    child.on('error', (err) => {
      resolve({
        success: false,
        exitCode: null,
        error: err.message,
      });
    });
  });
}
