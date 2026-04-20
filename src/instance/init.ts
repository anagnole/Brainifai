// ─── Instance initialization ────────────────────────────────────────────────
// Creates v2 FolderConfig-based instances. Global lives at ~/.brainifai/;
// project instances live at <workdir>/.brainifai/. Multiple instances can
// share a single .brainifai/ folder — each gets its own subdirectory.

import { mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import {
  GLOBAL_BRAINIFAI_PATH,
  BRAINIFAI_DIR,
  globalInstanceExists,
} from './resolve.js';
import {
  tryReadFolderConfig,
  writeFolderConfig,
  addInstance,
  emptyFolderConfig,
  FOLDER_CONFIG_FILE,
} from './folder-config.js';
import { getTemplate, TEMPLATES } from './templates.js';
import { generateDescription, mechanicalDescription } from './descriptions.js';
import { initializeInstanceDb } from './db.js';
import { registerWithGlobal } from './registry.js';
import { generateInstanceSkill } from './skill-generator.js';
import { runPopulateScript } from './populate.js';
import type { InstanceConfig, FolderConfig } from './types.js';
import { logger } from '../shared/logger.js';

// ─── Global init ────────────────────────────────────────────────────────────

export interface InitGlobalOptions {
  /** Currently only `general` is supported for global. */
  type?: string;
}

/**
 * Create the global instance at ~/.brainifai/ with a single `general` instance.
 * Throws if the global FolderConfig already exists.
 */
export async function initGlobalInstance(opts: InitGlobalOptions = {}): Promise<string> {
  const type = opts.type ?? 'general';
  if (type !== 'general') {
    throw new Error(`Global instance type must be "general" (got "${type}")`);
  }

  if (globalInstanceExists()) {
    throw new Error(`Global instance already exists at ${GLOBAL_BRAINIFAI_PATH}`);
  }

  const template = getTemplate(type) ?? TEMPLATES.general;
  const now = new Date().toISOString();
  const name = 'global';

  const description = await safeGenerateDescription({
    name, type, workdir: GLOBAL_BRAINIFAI_PATH, sources: template.sources,
  });

  const instanceConfig: InstanceConfig = {
    name,
    type,
    description,
    parent: null,
    sources: template.sources,
    contextFunctions: template.contextFunctions,
    createdAt: now,
    updatedAt: now,
  };

  const folderConfig: FolderConfig = {
    version: 1,
    instances: [instanceConfig],
  };

  // Create folder + instance subdir + DB dir
  mkdirSync(GLOBAL_BRAINIFAI_PATH, { recursive: true });
  const instancePath = resolve(GLOBAL_BRAINIFAI_PATH, name);
  const dbPath = resolve(instancePath, 'data', 'kuzu');
  mkdirSync(resolve(instancePath, 'data'), { recursive: true });

  writeFolderConfig(GLOBAL_BRAINIFAI_PATH, folderConfig);

  await initializeInstanceDb(dbPath, type);

  logger.info({ path: GLOBAL_BRAINIFAI_PATH, dbPath }, 'Global instance initialized');
  return GLOBAL_BRAINIFAI_PATH;
}

// ─── Project init ───────────────────────────────────────────────────────────

export interface InitProjectOptions {
  /** Absolute path to the folder the instance is bound to. */
  workdir: string;
  /** Instance type (e.g. `coding`, `researcher`). */
  type: string;
  /** Instance name. Defaults to `<basename(workdir)>-<type>`. */
  name?: string;
  /** Override the description. If omitted, an LLM default is generated. */
  description?: string;
  /** If true, offer/run the template's populate step. */
  populate?: boolean;
  /** If true and script exists, skip the prompt and run it. */
  populateAuto?: boolean;
  /** Optional domain hint (used by researcher). */
  domain?: string;
}

/**
 * Create a new instance in `<workdir>/.brainifai/`. If the folder already
 * hosts other instances, appends to the existing FolderConfig. Throws on
 * name collision — caller should auto-suffix.
 */
export async function initProjectInstance(opts: InitProjectOptions): Promise<{
  folderPath: string;
  instancePath: string;
  dbPath: string;
  instance: InstanceConfig;
}> {
  if (!globalInstanceExists()) {
    throw new Error(
      `Global instance not found at ${GLOBAL_BRAINIFAI_PATH}. ` +
      `Run \`brainifai init --global\` first.`,
    );
  }

  const template = getTemplate(opts.type);
  if (!template) {
    throw new Error(
      `Unknown instance type "${opts.type}". Available: ${Object.keys(TEMPLATES).join(', ')}`,
    );
  }

  const workdir = resolve(opts.workdir);
  const folderPath = resolve(workdir, BRAINIFAI_DIR);

  // Detect and report old (v1) layout: a config.json exists but isn't a FolderConfig.
  let existingConfig = null;
  if (existsSync(resolve(folderPath, FOLDER_CONFIG_FILE))) {
    try {
      existingConfig = tryReadFolderConfig(folderPath);
    } catch {
      throw new Error(
        `Old layout detected at ${folderPath}. ` +
        `Remove the .brainifai/ directory and re-run init.`,
      );
    }
  }

  const name = opts.name ?? defaultInstanceName(workdir, opts.type);
  if (existingConfig?.instances.some(i => i.name === name)) {
    throw new Error(
      `Instance "${name}" already exists in ${folderPath}. ` +
      `Choose a different name with --name.`,
    );
  }

  const description = opts.description ?? await safeGenerateDescription({
    name, type: opts.type, workdir,
    sources: template.sources,
    domain: opts.domain,
  });

  const now = new Date().toISOString();
  const instanceConfig: InstanceConfig = {
    name,
    type: opts.type,
    description,
    parent: 'global',
    sources: template.sources,
    contextFunctions: template.contextFunctions,
    domain: opts.domain,
    createdAt: now,
    updatedAt: now,
  };

  const instancePath = resolve(folderPath, name);
  const dbPath = resolve(instancePath, 'data', 'kuzu');

  // Create folder structure
  mkdirSync(resolve(instancePath, 'data'), { recursive: true });

  // Extend or create FolderConfig
  const nextConfig: FolderConfig = existingConfig
    ? addInstance(existingConfig, instanceConfig)
    : { version: 1, instances: [instanceConfig] };
  writeFolderConfig(folderPath, nextConfig);

  // Initialize DB schema
  // Skip for project-manager — its ingestion pipeline opens the DB itself.
  if (opts.type !== 'project-manager') {
    await initializeInstanceDb(dbPath, opts.type);
  }

  // Register with global
  await registerWithGlobal(name, opts.type, description, instancePath, now);

  // .gitignore: only if this is the first instance in the folder
  if (!existingConfig) {
    ensureGitignore(workdir);
  }

  // Skill generator sees the whole folder
  try {
    generateInstanceSkill({
      instancePath,
      projectPath: workdir,
      name,
      type: opts.type,
      description,
    });
  } catch (err) {
    logger.warn({ err }, 'Skill generation failed — continuing');
  }

  // Populate step
  if (opts.populate && template.populate) {
    logger.info({ script: template.populate.script }, 'Running populate script');
    const result = await runPopulateScript(template.populate, {
      instancePath, dbPath, instanceName: name,
    });
    if (!result.success) {
      logger.warn({ result }, 'Populate script failed — instance created anyway');
    }
  }

  return { folderPath, instancePath, dbPath, instance: instanceConfig };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Generate a description, falling back to mechanical if LLM fails. */
async function safeGenerateDescription(input: Parameters<typeof generateDescription>[0]): Promise<string> {
  try {
    return await generateDescription(input);
  } catch {
    return mechanicalDescription(input);
  }
}

/** `<basename(workdir)>-<type>`, unless type is 'general'. */
function defaultInstanceName(workdir: string, type: string): string {
  const base = basename(workdir) || 'instance';
  return type === 'general' ? base : `${base}-${type}`;
}

/** Auto-suffix helper for callers resolving collisions externally. */
export function resolveCollisionFreeName(
  config: FolderConfig | null,
  desired: string,
): string {
  if (!config) return desired;
  const taken = new Set(config.instances.map(i => i.name));
  if (!taken.has(desired)) return desired;
  for (let n = 2; n < 100; n++) {
    const candidate = `${desired}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not find a free name starting from "${desired}"`);
}

/** Append .brainifai/ to the project's .gitignore if not already present. */
function ensureGitignore(projectPath: string): void {
  const gitignorePath = resolve(projectPath, '.gitignore');
  const entry = '.brainifai/';

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (content.split('\n').some((line) => line.trim() === entry)) {
      return;
    }
    const separator = content.endsWith('\n') ? '' : '\n';
    appendFileSync(gitignorePath, `${separator}${entry}\n`);
  } else {
    appendFileSync(gitignorePath, `${entry}\n`);
  }
}
