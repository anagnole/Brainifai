// ─── v2 FolderConfig resolution ─────────────────────────────────────────────
// The v2 layout hosts multiple instances per folder in a single
// .brainifai/config.json (FolderConfig). Each instance has its own subdirectory
// containing its Kuzu DB: <folder>/.brainifai/<name>/data/kuzu/
//
// Globals: ~/.brainifai/config.json + ~/.brainifai/general/data/kuzu/

import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import type { InstanceConfig, ResolvedInstance, FolderConfig, RecentActivity } from './types.js';
import {
  FOLDER_CONFIG_FILE,
  readFolderConfig,
  tryReadFolderConfig,
  writeFolderConfig,
  resolvePathsFor,
  updateInstance,
  findInstance as findInstanceInFolder,
} from './folder-config.js';

export const GLOBAL_BRAINIFAI_PATH = resolve(homedir(), '.brainifai');
export const INSTANCE_CONFIG_FILE = FOLDER_CONFIG_FILE;
export const BRAINIFAI_DIR = '.brainifai';

/**
 * Walk up from `from` looking for a `.brainifai/config.json`.
 * Returns the absolute path to the `.brainifai/` directory, or null if none.
 * Skips the global path so project resolution never matches global.
 */
export function findFolderConfigPath(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  const root = resolve('/');

  while (dir !== root) {
    const folder = resolve(dir, BRAINIFAI_DIR);
    const configPath = resolve(folder, FOLDER_CONFIG_FILE);
    if (existsSync(configPath) && folder !== GLOBAL_BRAINIFAI_PATH) {
      return folder;
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Find the nearest folder with a FolderConfig, falling back to global.
 * Honors BRAINIFAI_INSTANCE_PATH env var and CLAUDE_PROJECT_DIR.
 * Returns the folder path even if no config.json exists there yet.
 */
export function resolveFolderPath(from?: string): string {
  if (process.env.BRAINIFAI_INSTANCE_PATH) {
    return process.env.BRAINIFAI_INSTANCE_PATH;
  }
  const projectFolder = findFolderConfigPath(from);
  if (projectFolder) return projectFolder;

  if (!from && process.env.CLAUDE_PROJECT_DIR) {
    const fromClaude = findFolderConfigPath(process.env.CLAUDE_PROJECT_DIR);
    if (fromClaude) return fromClaude;
  }
  return GLOBAL_BRAINIFAI_PATH;
}

/** True if the global FolderConfig exists at `~/.brainifai/config.json`. */
export function globalInstanceExists(): boolean {
  return existsSync(resolve(GLOBAL_BRAINIFAI_PATH, FOLDER_CONFIG_FILE));
}

/** All instances in the resolved folder, each with their paths computed. */
export function resolveInstances(from?: string): {
  folderPath: string;
  instances: ResolvedInstance[];
} {
  const folderPath = resolveFolderPath(from);
  const cfg = tryReadFolderConfig(folderPath);
  if (!cfg) return { folderPath, instances: [] };
  return {
    folderPath,
    instances: cfg.instances.map(inst => resolvePathsFor(folderPath, inst)),
  };
}

/**
 * Resolve a single instance from the nearest folder.
 * - If `name` is given: look up by name (throws if not found).
 * - If omitted and the folder has exactly one instance: return it.
 * - If omitted and multiple instances exist: honor BRAINIFAI_INSTANCE_NAME,
 *   otherwise throw with guidance.
 */
export function resolveInstance(from?: string, name?: string): ResolvedInstance {
  const { folderPath, instances } = resolveInstances(from);
  if (instances.length === 0) {
    throw new Error(
      `No Brainifai instances found in folder: ${folderPath}. ` +
      `Run \`brainifai init\` to create one.`,
    );
  }

  const requested = name ?? process.env.BRAINIFAI_INSTANCE_NAME;
  if (requested) {
    const match = instances.find(i => i.config.name === requested);
    if (!match) {
      throw new Error(
        `Instance "${requested}" not found in ${folderPath}. ` +
        `Available: ${instances.map(i => i.config.name).join(', ')}`,
      );
    }
    return match;
  }

  if (instances.length === 1) return instances[0]!;

  throw new Error(
    `Folder ${folderPath} has multiple instances: ` +
    `${instances.map(i => i.config.name).join(', ')}. ` +
    `Specify one via --instance <name> or BRAINIFAI_INSTANCE_NAME env var.`,
  );
}

/**
 * Resolve the Kuzu DB path for the current context.
 * Priority: KUZU_DB_PATH env > resolved instance's dbPath.
 */
export function resolveInstanceDbPath(from?: string, name?: string): string {
  if (process.env.KUZU_DB_PATH) return process.env.KUZU_DB_PATH;
  return resolveInstance(from, name).dbPath;
}

/** Resolve the folder (`.brainifai/`) path — does not require instances. */
export function resolveInstancePath(from?: string): string {
  return resolveFolderPath(from);
}

/** Read the FolderConfig at a folder path, or null if absent. */
export function readFolderConfigAt(folderPath: string): FolderConfig | null {
  return tryReadFolderConfig(folderPath);
}

/** Look up an instance by name within an already-loaded folder config. */
export function findInstanceInConfig(
  config: FolderConfig,
  name: string,
): InstanceConfig | null {
  return findInstanceInFolder(config, name);
}

const MAX_RECENT_ACTIVITIES = 5;

/**
 * Push a recent activity to a specific instance within a folder config (FIFO, max 5).
 * Writes the whole FolderConfig atomically.
 */
export function pushRecentActivity(
  folderPath: string,
  instanceName: string,
  activity: RecentActivity,
): void {
  const cfg = readFolderConfig(folderPath);
  const instance = findInstanceInFolder(cfg, instanceName);
  if (!instance) {
    throw new Error(`Instance "${instanceName}" not found in ${folderPath}`);
  }
  const recents = instance.recentActivities ?? [];
  recents.push(activity);
  if (recents.length > MAX_RECENT_ACTIVITIES) {
    recents.splice(0, recents.length - MAX_RECENT_ACTIVITIES);
  }
  const updated: InstanceConfig = {
    ...instance,
    recentActivities: recents,
    updatedAt: new Date().toISOString(),
  };
  writeFolderConfig(folderPath, updateInstance(cfg, instanceName, updated));
}
