import { Command } from 'commander';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { findProjectInstance, readInstanceConfig, globalInstanceExists, GLOBAL_BRAINIFAI_PATH } from '../../instance/resolve.js';

export function statusCommand(): Command {
  return new Command('status')
    .description('Show current instance info and health')
    .action(async () => {
      const projectPath = findProjectInstance();
      const instancePath = projectPath ?? (globalInstanceExists() ? GLOBAL_BRAINIFAI_PATH : null);

      if (!instancePath) {
        console.log('No Brainifai instance found. Run `brainifai init` to create one.');
        return;
      }

      const config = readInstanceConfig(instancePath);
      const dbPath = resolve(instancePath, 'data', 'kuzu');
      const dbExists = existsSync(dbPath);

      console.log(`Instance:     ${config.name}`);
      console.log(`Type:         ${config.type}`);
      console.log(`Path:         ${instancePath}`);
      console.log(`Parent:       ${config.parent ?? '(root)'}`);
      console.log(`Description:  ${config.description}`);
      console.log(`DB:           ${dbExists ? 'OK' : 'MISSING'} (${dbPath})`);
      console.log(`Sources:      ${config.sources.filter(s => s.enabled).map(s => s.source).join(', ') || 'none'}`);
      console.log(`Created:      ${config.createdAt}`);
      console.log(`Last updated: ${config.updatedAt}`);
      if (config.lastIngestion) {
        console.log(`Last ingest:  ${config.lastIngestion}`);
      }
    });
}
