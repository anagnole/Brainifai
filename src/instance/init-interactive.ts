// ─── Interactive init ───────────────────────────────────────────────────────
// Walks the user through creating a new instance via `prompts`. Uses the LLM
// description generator to propose a default, which the user can accept or edit.

import prompts from 'prompts';
import { basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { TEMPLATES, getTemplate } from './templates.js';
import { generateDescription, mechanicalDescription } from './descriptions.js';
import {
  resolveCollisionFreeName,
  initProjectInstance,
  type InitProjectOptions,
} from './init.js';
import { tryReadFolderConfig } from './folder-config.js';
import { BRAINIFAI_DIR } from './resolve.js';

export interface InteractiveInitResult {
  folderPath: string;
  instancePath: string;
  dbPath: string;
  instanceName: string;
}

/**
 * Run the interactive init flow. Prompts the user for type, workdir, name,
 * description, and populate choice. Then creates the instance.
 */
export async function runInteractiveInit(): Promise<InteractiveInitResult | null> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Interactive init requires a TTY. Use flag-driven init: ' +
      '`brainifai init --type <type> --workdir <path> --name <name>`',
    );
  }

  const typeChoices = Object.values(TEMPLATES)
    .filter((t) => t.type !== 'general')   // general is only for global
    .map((t) => ({
      title: t.type,
      description: t.description.slice(0, 80),
      value: t.type,
    }));

  const step1 = await prompts({
    type: 'select',
    name: 'type',
    message: 'Instance type',
    choices: typeChoices,
    initial: 0,
  });
  if (step1.type === undefined) return null; // user bailed (Ctrl-C)

  const step2 = await prompts({
    type: 'text',
    name: 'workdir',
    message: 'Workdir (folder this instance covers)',
    initial: process.cwd(),
    validate: (val: string) => existsSync(resolve(val)) || 'Path does not exist',
  });
  if (step2.workdir === undefined) return null;

  const workdir = resolve(step2.workdir);
  const folderPath = resolve(workdir, BRAINIFAI_DIR);
  const existingConfig = tryReadFolderConfig(folderPath);

  const defaultName = step1.type === 'general'
    ? basename(workdir) || 'instance'
    : `${basename(workdir) || 'instance'}-${step1.type}`;
  const suggestedName = resolveCollisionFreeName(existingConfig, defaultName);

  const step3 = await prompts({
    type: 'text',
    name: 'name',
    message: 'Instance name',
    initial: suggestedName,
    validate: (val: string) => {
      if (!/^[a-zA-Z0-9][\w-]*$/.test(val)) return 'Use alphanumerics, dashes, and underscores';
      if (existingConfig?.instances.some(i => i.name === val)) return 'Name already used in this folder';
      return true;
    },
  });
  if (step3.name === undefined) return null;

  // Optional domain prompt (researcher)
  let domain: string | undefined;
  if (step1.type === 'researcher') {
    const domainStep = await prompts({
      type: 'text',
      name: 'domain',
      message: 'Research domain (e.g. "cryptocurrency", "AI safety")',
      initial: '',
    });
    if (domainStep.domain === undefined) return null;
    domain = domainStep.domain || undefined;
  }

  // Generate description suggestion
  const template = getTemplate(step1.type)!;
  const suggestedDescription = await safeGenerate({
    name: step3.name,
    type: step1.type,
    workdir,
    sources: template.sources,
    domain,
  });

  const step4 = await prompts({
    type: 'text',
    name: 'description',
    message: 'Description',
    initial: suggestedDescription,
  });
  if (step4.description === undefined) return null;

  // Populate step (only if template declares it)
  let populate = false;
  if (template.populate) {
    const step5 = await prompts({
      type: 'confirm',
      name: 'populate',
      message: template.populate.prompt,
      initial: true,
    });
    if (step5.populate === undefined) return null;
    populate = Boolean(step5.populate);
  }

  // Execute
  const opts: InitProjectOptions = {
    workdir,
    type: step1.type,
    name: step3.name,
    description: step4.description,
    populate,
    domain,
  };

  const result = await initProjectInstance(opts);
  return {
    folderPath: result.folderPath,
    instancePath: result.instancePath,
    dbPath: result.dbPath,
    instanceName: result.instance.name,
  };
}

async function safeGenerate(input: Parameters<typeof generateDescription>[0]): Promise<string> {
  try {
    return await generateDescription(input);
  } catch {
    return mechanicalDescription(input);
  }
}
