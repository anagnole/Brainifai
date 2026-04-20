import { Command } from 'commander';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { getInstanceByName, unregisterInstance } from '../../instance/registry.js';
import { readFolderConfigAt } from '../../instance/resolve.js';
import { removeInstance, writeFolderConfig } from '../../instance/folder-config.js';

export function removeCommand(): Command {
  return new Command('remove')
    .description('Remove an instance: unregisters globally, drops from FolderConfig, deletes subdir')
    .argument('<name>', 'Instance name to remove')
    .option('--keep-data', 'Do not delete the instance subdirectory (only unregister)')
    .action(async (name: string, opts: { keepData?: boolean }) => {
      const entry = await getInstanceByName(name);
      if (!entry) {
        console.error(`Instance "${name}" not found in registry.`);
        process.exitCode = 1;
        return;
      }

      // v2: entry.path is <folder>/.brainifai/<name>/; folder is its parent.
      const folderPath = dirname(entry.path);
      const folderCfg = readFolderConfigAt(folderPath);

      if (folderCfg) {
        const next = removeInstance(folderCfg, name);
        writeFolderConfig(folderPath, next);
        console.log(`✓ Removed "${name}" from ${folderPath}/config.json`);
      } else {
        console.warn(`No FolderConfig at ${folderPath} — skipping config update`);
      }

      if (!opts.keepData) {
        try {
          rmSync(entry.path, { recursive: true, force: true });
          console.log(`✓ Deleted ${entry.path}`);
        } catch (err) {
          console.warn(`Could not delete ${entry.path}: ${(err as Error).message}`);
        }
      }

      const success = await unregisterInstance(name);
      if (success) {
        console.log(`✓ Instance "${name}" marked removed in global registry`);
      } else {
        console.error(`Failed to unregister "${name}" from global registry`);
        process.exitCode = 1;
      }
    });
}
