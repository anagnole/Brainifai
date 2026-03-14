import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import type { InstanceConfig } from './types.js';

export const GLOBAL_BRAINIFAI_PATH = resolve(homedir(), '.brainifai');
export const INSTANCE_CONFIG_FILE = 'config.json';

/** Walk up from cwd looking for a .brainifai/ directory */
export function findProjectInstance(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  const root = resolve('/');
  const globalPath = GLOBAL_BRAINIFAI_PATH;

  while (dir !== root) {
    const candidate = resolve(dir, '.brainifai', INSTANCE_CONFIG_FILE);
    // Don't match the global instance when looking for project instances
    if (existsSync(candidate) && resolve(dir, '.brainifai') !== globalPath) {
      return resolve(dir, '.brainifai');
    }
    dir = dirname(dir);
  }
  return null;
}

export function globalInstanceExists(): boolean {
  return existsSync(resolve(GLOBAL_BRAINIFAI_PATH, INSTANCE_CONFIG_FILE));
}

export function readInstanceConfig(instancePath: string): InstanceConfig {
  const configPath = resolve(instancePath, INSTANCE_CONFIG_FILE);
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  return raw as InstanceConfig;
}

export function writeInstanceConfig(instancePath: string, config: InstanceConfig): void {
  const configPath = resolve(instancePath, INSTANCE_CONFIG_FILE);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Resolve the Kuzu DB path for the current context:
 * 1. KUZU_DB_PATH env var (explicit override)
 * 2. Nearest project .brainifai/data/kuzu (walk up from cwd)
 * 3. Global ~/.brainifai/data/kuzu (fallback)
 */
export function resolveInstanceDbPath(from?: string): string {
  if (process.env.KUZU_DB_PATH) {
    return process.env.KUZU_DB_PATH;
  }

  const projectInstance = findProjectInstance(from);
  if (projectInstance) {
    return resolve(projectInstance, 'data', 'kuzu');
  }

  return resolve(GLOBAL_BRAINIFAI_PATH, 'data', 'kuzu');
}

/** Resolve instance path (not DB path) for current context */
export function resolveInstancePath(from?: string): string {
  const projectInstance = findProjectInstance(from);
  return projectInstance ?? GLOBAL_BRAINIFAI_PATH;
}
