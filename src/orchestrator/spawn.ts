import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '../shared/logger.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import type { InstanceContext } from './types.js';
import { ORCHESTRATOR_TIMEOUT_MS } from '../shared/constants.js';

const BRAINIFAI_ROOT = resolve(import.meta.dirname, '..', '..');

export interface SpawnResult {
  success: boolean;
  globalIndices: number[];
  error?: string;
}

/**
 * Spawn a Claude CLI process to route a batch of messages to instances.
 * Returns the indices of messages marked for global by the orchestrator.
 */
export async function spawnOrchestrator(
  sourceName: string,
  batchFile: string,
  messageCount: number,
  children: InstanceContext[],
): Promise<SpawnResult> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'brainifai-orch-'));
  const mcpConfigPath = join(tmpDir, 'mcp.json');
  const globalIndicesPath = join(tmpDir, 'global-indices.json');

  // Initialize empty global indices file
  writeFileSync(globalIndicesPath, '[]');

  const mcpConfig = {
    mcpServers: {
      orchestrator: {
        command: 'npx',
        args: ['tsx', resolve(BRAINIFAI_ROOT, 'src/orchestrator/mcp-server.ts')],
        cwd: BRAINIFAI_ROOT,
        env: {
          BRAINIFAI_INSTANCE_REGISTRY: JSON.stringify(
            children.map(c => ({ name: c.name, path: c.path })),
          ),
          BRAINIFAI_BATCH_FILE: batchFile,
          BRAINIFAI_GLOBAL_INDICES_FILE: globalIndicesPath,
        },
      },
    },
  };

  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

  const systemPrompt = buildSystemPrompt(children);
  const userPrompt = buildUserPrompt(sourceName, messageCount, batchFile);

  logger.info({ source: sourceName, messageCount, children: children.length }, 'Spawning orchestrator');

  const args = [
    '--print',
    '--output-format', 'json',
    '--model', 'claude-sonnet-4-6',
    '--system-prompt', systemPrompt,
    `--mcp-config=${mcpConfigPath}`,
    '--strict-mcp-config',
    '--allowedTools',
    'mcp__orchestrator__push_to_instance',
    'mcp__orchestrator__mark_as_global',
    'Read',
    '--disallowedTools',
    'Bash', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'WebSearch', 'WebFetch',
    '--permission-mode', 'bypassPermissions',
    '--max-turns', '50',
    '--max-budget-usd', '5.00',
    '--', userPrompt,
  ];

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  return new Promise<SpawnResult>((resolvePromise) => {
    const child = spawn('claude', args, {
      cwd: tmpDir, // Neutral directory — prevents inheriting project context
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stderr = '';
    let stdout = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      resolvePromise({ success: false, globalIndices: [], error: `Orchestrator timed out after ${ORCHESTRATOR_TIMEOUT_MS}ms` });
    }, ORCHESTRATOR_TIMEOUT_MS);

    const readGlobalIndices = (): number[] => {
      try {
        if (existsSync(globalIndicesPath)) {
          return JSON.parse(readFileSync(globalIndicesPath, 'utf-8'));
        }
      } catch { /* ignore */ }
      return [];
    };

    child.on('close', (code: number | null) => {
      clearTimeout(timeout);
      const globalIndices = readGlobalIndices();

      // Clean up temp files
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }

      if (code === 0) {
        logger.info({ source: sourceName, globalCount: globalIndices.length }, 'Orchestrator completed');
        resolvePromise({ success: true, globalIndices });
      } else {
        const errorMsg = `Orchestrator exited with code ${code}: stderr=${stderr.slice(0, 500)} stdout=${stdout.slice(0, 500)}`;
        logger.error({ source: sourceName, code, stderr: stderr.slice(0, 500), stdout: stdout.slice(0, 500) }, 'Orchestrator failed');
        resolvePromise({ success: false, globalIndices, error: errorMsg });
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeout);
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
      logger.error({ source: sourceName, err }, 'Failed to spawn orchestrator');
      resolvePromise({ success: false, globalIndices: [], error: err.message });
    });
  });
}
