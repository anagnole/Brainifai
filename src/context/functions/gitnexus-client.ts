// ─── GitNexus CLI Client ──────────────────────────────────────────────────────

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

function resolveGitNexusBin(): string {
  try {
    return execFileSync('which', ['gitnexus'], { encoding: 'utf8' }).trim();
  } catch {
    return 'gitnexus'; // fall back to PATH lookup at execution time
  }
}

const GITNEXUS_BIN = resolveGitNexusBin();
const TIMEOUT_MS = 30_000;

export interface GitNexusError {
  code: 'not_indexed' | 'timeout' | 'command_not_found' | 'unknown';
  message: string;
}

export type GitNexusResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: GitNexusError };

/**
 * Auto-detect the repository name from CLAUDE_PROJECT_DIR env or cwd.
 * GitNexus uses the directory basename as the repo name.
 */
export function detectRepoName(): string | undefined {
  const projectDir = process.env['CLAUDE_PROJECT_DIR'];
  const cwd = projectDir ?? process.cwd();
  return path.basename(cwd) || undefined;
}

/**
 * Execute a GitNexus CLI command, parse JSON output, handle errors gracefully.
 * Falls back to { raw: string } when output is not valid JSON.
 */
export async function execGitNexus<T = unknown>(
  command: string,
  args: string[],
): Promise<GitNexusResult<T>> {
  try {
    const { stdout, stderr } = await execFileAsync(
      GITNEXUS_BIN,
      [command, ...args],
      { timeout: TIMEOUT_MS },
    );

    const output = stdout.trim();

    if (!output) {
      const errText = stderr.trim();
      const lower = errText.toLowerCase();
      if (lower.includes('not indexed') || lower.includes('no index') || lower.includes('not found')) {
        return { ok: false, error: { code: 'not_indexed', message: errText || 'Repository not indexed in GitNexus' } };
      }
      if (lower.includes('unknown command') || lower.includes('error: unknown')) {
        return { ok: false, error: { code: 'command_not_found', message: `GitNexus command '${command}' not found` } };
      }
      return { ok: false, error: { code: 'unknown', message: errText || 'No output from GitNexus' } };
    }

    try {
      return { ok: true, data: JSON.parse(output) as T };
    } catch {
      // Not JSON — wrap raw text
      return { ok: true, data: { raw: output } as unknown as T };
    }
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      killed?: boolean;
      stderr?: string;
      stdout?: string;
    };

    if (e.killed) {
      return { ok: false, error: { code: 'timeout', message: 'GitNexus timed out after 30s' } };
    }

    const stderr = e.stderr ?? '';
    const lower = stderr.toLowerCase();

    if (lower.includes('not indexed') || lower.includes('no index')) {
      return { ok: false, error: { code: 'not_indexed', message: stderr } };
    }
    if (lower.includes('unknown command') || lower.includes('error: unknown')) {
      return { ok: false, error: { code: 'command_not_found', message: `GitNexus command '${command}' not found` } };
    }

    return {
      ok: false,
      error: { code: 'unknown', message: e.message ?? String(e) },
    };
  }
}
