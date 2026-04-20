// ─── Folder-level config I/O (v2 layout) ────────────────────────────────────
// A .brainifai/ folder contains a single config.json describing one or more
// instances. Each instance has its own subdirectory (by instance name) holding
// its Kuzu DB. This module provides pure read/write/mutation helpers.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FolderConfig, InstanceConfig, ResolvedInstance } from './types.js';

export const FOLDER_CONFIG_FILE = 'config.json';

/** Read a folder's config.json. Throws if missing or malformed. */
export function readFolderConfig(folderPath: string): FolderConfig {
  const configPath = resolve(folderPath, FOLDER_CONFIG_FILE);
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return validateFolderConfig(parsed);
}

/** Read if present, return null if missing. Throws on malformed. */
export function tryReadFolderConfig(folderPath: string): FolderConfig | null {
  const configPath = resolve(folderPath, FOLDER_CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  return readFolderConfig(folderPath);
}

/** Write the config atomically (via rename). */
export function writeFolderConfig(folderPath: string, config: FolderConfig): void {
  const configPath = resolve(folderPath, FOLDER_CONFIG_FILE);
  const tmpPath = configPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n');
  renameSync(tmpPath, configPath);
}

/** Return a new config with the given instance appended. Throws if name collides. */
export function addInstance(config: FolderConfig, instance: InstanceConfig): FolderConfig {
  if (config.instances.some(i => i.name === instance.name)) {
    throw new Error(`Instance "${instance.name}" already exists in this folder.`);
  }
  return { ...config, instances: [...config.instances, instance] };
}

/** Return a new config without the named instance. Silent no-op if missing. */
export function removeInstance(config: FolderConfig, name: string): FolderConfig {
  return { ...config, instances: config.instances.filter(i => i.name !== name) };
}

/** Return a new config where the named instance is replaced with `updated`. */
export function updateInstance(config: FolderConfig, name: string, updated: InstanceConfig): FolderConfig {
  const idx = config.instances.findIndex(i => i.name === name);
  if (idx < 0) throw new Error(`Instance "${name}" not found in this folder.`);
  const next = [...config.instances];
  next[idx] = updated;
  return { ...config, instances: next };
}

/** Look up an instance by name. */
export function findInstance(config: FolderConfig, name: string): InstanceConfig | null {
  return config.instances.find(i => i.name === name) ?? null;
}

/** Create an empty FolderConfig scaffold. */
export function emptyFolderConfig(): FolderConfig {
  return { version: 1, instances: [] };
}

/** Compute per-instance paths from a folder path. */
export function resolvePathsFor(folderPath: string, instance: InstanceConfig): ResolvedInstance {
  const instancePath = resolve(folderPath, instance.name);
  const dbPath = resolve(instancePath, 'data', 'kuzu');
  return { config: instance, folderPath, instancePath, dbPath };
}

/** Basic structural validation. Throws on bad shape. */
function validateFolderConfig(raw: unknown): FolderConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('FolderConfig: expected object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`FolderConfig: unsupported version ${String(obj.version)}; expected 1`);
  }
  if (!Array.isArray(obj.instances)) {
    throw new Error('FolderConfig: "instances" must be an array');
  }
  // We trust per-instance shape for now; downstream code will type-narrow.
  return { version: 1, instances: obj.instances as InstanceConfig[] };
}
