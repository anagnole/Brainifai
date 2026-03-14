import { Command } from 'commander';
import { findProjectInstance, readInstanceConfig, writeInstanceConfig, globalInstanceExists, GLOBAL_BRAINIFAI_PATH } from '../../instance/resolve.js';
import { syncDescription } from '../../instance/registry.js';

export function describeCommand(): Command {
  return new Command('describe')
    .description('Update the instance description')
    .argument('<description>', 'New description text')
    .action(async (description: string) => {
      const projectPath = findProjectInstance();
      const instancePath = projectPath ?? (globalInstanceExists() ? GLOBAL_BRAINIFAI_PATH : null);

      if (!instancePath) {
        console.error('No Brainifai instance found. Run `brainifai init` first.');
        process.exitCode = 1;
        return;
      }

      const config = readInstanceConfig(instancePath);
      const previous = config.description;
      config.description = description;
      config.updatedAt = new Date().toISOString();
      writeInstanceConfig(instancePath, config);

      // Sync to global registry if this is a child
      if (config.parent) {
        try {
          await syncDescription(config.name, description);
        } catch {
          console.warn('Warning: Failed to sync description to global registry.');
        }
      }

      console.log(`Updated description for "${config.name}"`);
      console.log(`  Previous: ${previous}`);
      console.log(`  New:      ${description}`);
    });
}
