import { existsSync } from 'fs';
import { resolve } from 'path';
import { listInstances, unregisterInstance } from './registry.js';
import { INSTANCE_CONFIG_FILE, readInstanceConfig } from './resolve.js';
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
  const configPath = resolve(entry.path, INSTANCE_CONFIG_FILE);
  const dbPath = resolve(entry.path, 'data', 'kuzu');

  const configExists = existsSync(configPath);
  const dbExists = existsSync(dbPath);
  let configMatch = false;

  if (!configExists) {
    issues.push(`Config missing at ${configPath} — directory may have been moved or deleted`);
  } else {
    try {
      const config = readInstanceConfig(entry.path);
      configMatch = config.name === entry.name;
      if (!configMatch) {
        issues.push(`Config name "${config.name}" doesn't match registry name "${entry.name}"`);
      }
    } catch {
      issues.push('Config file exists but is unreadable/corrupt');
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
