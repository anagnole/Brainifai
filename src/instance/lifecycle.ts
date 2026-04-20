import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { listInstances, unregisterInstance } from './registry.js';
import { readFolderConfigAt } from './resolve.js';
import { findInstance } from './folder-config.js';
import type { InstanceRegistryEntry } from './types.js';

export interface HealthCheckResult {
  instance: InstanceRegistryEntry;
  configExists: boolean;
  dbExists: boolean;
  configMatch: boolean;
  issues: string[];
}

/** Check health of all registered instances */
export async function checkAllInstances(): Promise<HealthCheckResult[]> {
  const instances = await listInstances({ status: 'active' });
  return instances.map(checkInstance);
}

function checkInstance(entry: InstanceRegistryEntry): HealthCheckResult {
  const issues: string[] = [];
  // v2: entry.path = <folder>/.brainifai/<name>/; folder config is one level up.
  const folderPath = dirname(entry.path);
  const dbPath = resolve(entry.path, 'data', 'kuzu');
  const dbExists = existsSync(dbPath);

  const folderCfg = readFolderConfigAt(folderPath);
  const configExists = folderCfg !== null;
  let configMatch = false;

  if (!configExists) {
    issues.push(`FolderConfig missing at ${folderPath} — folder may have been moved or deleted`);
  } else {
    const inst = findInstance(folderCfg, entry.name);
    if (!inst) {
      issues.push(`Instance "${entry.name}" not listed in ${folderPath}/config.json`);
    } else {
      configMatch = true;
    }
  }

  if (!dbExists) {
    issues.push(`Kuzu DB missing at ${dbPath}`);
  }

  return { instance: entry, configExists, dbExists, configMatch, issues };
}

/** Mark missing instances as stale, optionally remove them */
export async function cleanupStaleInstances(autoRemove = false): Promise<string[]> {
  const results = await checkAllInstances();
  const stale = results.filter(r => !r.configExists);
  const cleaned: string[] = [];

  for (const result of stale) {
    if (autoRemove) {
      await unregisterInstance(result.instance.name);
      cleaned.push(result.instance.name);
    }
  }

  return cleaned;
}
