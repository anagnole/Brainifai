import { mkdirSync, existsSync, readFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import { GLOBAL_BRAINIFAI_PATH, writeInstanceConfig, INSTANCE_CONFIG_FILE } from './resolve.js';
import { getTemplate, TEMPLATES } from './templates.js';
import { generateDescription } from './descriptions.js';
import { initializeInstanceDb } from './db.js';
import { registerWithGlobal } from './registry.js';
import type { InstanceConfig } from './types.js';

export interface InitGlobalOptions {
  type?: string;       // defaults to 'general'
}

export interface InitProjectOptions {
  name: string;
  type: string;
  description?: string;  // auto-generated if omitted
  projectPath: string;   // absolute path to the project root
}

/** Create the global instance at ~/.brainifai/ */
export async function initGlobalInstance(opts: InitGlobalOptions = {}): Promise<string> {
  const configPath = resolve(GLOBAL_BRAINIFAI_PATH, INSTANCE_CONFIG_FILE);

  if (existsSync(configPath)) {
    throw new Error('Global instance already exists at ' + GLOBAL_BRAINIFAI_PATH);
  }

  const template = getTemplate(opts.type ?? 'general') ?? TEMPLATES.general;
  const now = new Date().toISOString();

  const config: InstanceConfig = {
    name: 'global',
    type: opts.type ?? 'general',
    description: 'Global Brainifai instance — root of the instance tree',
    parent: null,
    sources: template.sources,
    contextFunctions: template.contextFunctions,
    createdAt: now,
    updatedAt: now,
  };

  // Create directories (recursive is safe if they already exist)
  const dbPath = resolve(GLOBAL_BRAINIFAI_PATH, 'data', 'kuzu');
  mkdirSync(GLOBAL_BRAINIFAI_PATH, { recursive: true });

  // Write config
  writeInstanceConfig(GLOBAL_BRAINIFAI_PATH, config);

  // Initialize DB schema only if the DB doesn't already exist (migration path:
  // existing ~/.brainifai/data/kuzu from pre-instance era gets wrapped in config)
  if (!existsSync(dbPath)) {
    mkdirSync(dbPath, { recursive: true });
    await initializeInstanceDb(dbPath);
  }

  return GLOBAL_BRAINIFAI_PATH;
}

/** Create a project instance at <projectPath>/.brainifai/ */
export async function initProjectInstance(opts: InitProjectOptions): Promise<string> {
  const instancePath = resolve(opts.projectPath, '.brainifai');

  if (existsSync(resolve(instancePath, INSTANCE_CONFIG_FILE))) {
    throw new Error('Instance already exists at ' + instancePath);
  }

  // Global must exist first
  if (!existsSync(resolve(GLOBAL_BRAINIFAI_PATH, INSTANCE_CONFIG_FILE))) {
    throw new Error('Global instance not found. Run `brainifai init` outside a project first.');
  }

  const template = getTemplate(opts.type);
  const now = new Date().toISOString();
  const description = opts.description ?? generateDescription(
    opts.name,
    opts.type,
    template?.sources ?? [],
  );

  const config: InstanceConfig = {
    name: opts.name,
    type: opts.type,
    description,
    parent: 'global',
    sources: template?.sources ?? [],
    contextFunctions: template?.contextFunctions ?? [],
    createdAt: now,
    updatedAt: now,
  };

  // Create directories — only create parent; Kuzu creates its own DB dir
  const dbPath = resolve(instancePath, 'data', 'kuzu');
  mkdirSync(resolve(instancePath, 'data'), { recursive: true });

  // Write config
  writeInstanceConfig(instancePath, config);

  // Initialize DB schema
  await initializeInstanceDb(dbPath);

  // Register with global instance
  await registerWithGlobal(opts.name, opts.type, description, instancePath, now);

  // Ensure .brainifai/ is in the project's .gitignore
  ensureGitignore(opts.projectPath);

  return instancePath;
}

/** Append .brainifai/ to the project's .gitignore if not already present */
function ensureGitignore(projectPath: string): void {
  const gitignorePath = resolve(projectPath, '.gitignore');
  const entry = '.brainifai/';

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (content.split('\n').some(line => line.trim() === entry)) {
      return; // already present
    }
    const separator = content.endsWith('\n') ? '' : '\n';
    appendFileSync(gitignorePath, `${separator}${entry}\n`);
  } else {
    appendFileSync(gitignorePath, `${entry}\n`);
  }
}
