import { Command } from 'commander';
import {
  resolveInstance,
  readFolderConfigAt,
  globalInstanceExists,
} from '../../instance/resolve.js';
import { writeFolderConfig, updateInstance } from '../../instance/folder-config.js';
import { syncDescription } from '../../instance/registry.js';

export function describeCommand(): Command {
  return new Command('describe')
    .description('Update an instance description')
    .argument('<description>', 'New description text')
    .option('--instance <name>', 'Instance name (required if folder has multiple)')
    .action(async (description: string, opts: { instance?: string }) => {
      if (!globalInstanceExists()) {
        console.error('No Brainifai instance found. Run `brainifai init --global` first.');
        process.exitCode = 1;
        return;
      }

      let resolved;
      try {
        resolved = resolveInstance(undefined, opts.instance);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      const folderCfg = readFolderConfigAt(resolved.folderPath);
      if (!folderCfg) {
        console.error(`No FolderConfig at ${resolved.folderPath}`);
        process.exitCode = 1;
        return;
      }

      const previous = resolved.config.description;
      const updated = {
        ...resolved.config,
        description,
        updatedAt: new Date().toISOString(),
      };
      writeFolderConfig(
        resolved.folderPath,
        updateInstance(folderCfg, resolved.config.name, updated),
      );

      if (resolved.config.parent) {
        try {
          await syncDescription(resolved.config.name, description);
        } catch {
          console.warn('Warning: Failed to sync description to global registry.');
        }
      }

      console.log(`Updated description for "${resolved.config.name}"`);
      console.log(`  Previous: ${previous}`);
      console.log(`  New:      ${description}`);
    });
}
