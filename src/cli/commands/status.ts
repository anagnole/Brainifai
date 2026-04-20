import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { globalInstanceExists, resolveInstances } from '../../instance/resolve.js';

export function statusCommand(): Command {
  return new Command('status')
    .description('Show instances in the resolved folder and their health')
    .action(async () => {
      if (!globalInstanceExists()) {
        console.log('No Brainifai global instance. Run `brainifai init --global`.');
        return;
      }

      const { folderPath, instances } = resolveInstances();
      if (instances.length === 0) {
        console.log(`No instances in ${folderPath}. Run \`brainifai init\` to create one.`);
        return;
      }

      console.log(`Folder: ${folderPath}\n`);
      for (const inst of instances) {
        const dbOk = existsSync(inst.dbPath);
        console.log(`Instance:     ${inst.config.name}`);
        console.log(`Type:         ${inst.config.type}`);
        console.log(`Path:         ${inst.instancePath}`);
        console.log(`Parent:       ${inst.config.parent ?? '(root)'}`);
        console.log(`Description:  ${inst.config.description}`);
        console.log(`DB:           ${dbOk ? 'OK' : 'MISSING'} (${inst.dbPath})`);
        console.log(`Sources:      ${inst.config.sources.filter((s) => s.enabled).map((s) => s.source).join(', ') || 'none'}`);
        console.log(`Created:      ${inst.config.createdAt}`);
        console.log(`Last updated: ${inst.config.updatedAt}`);
        if (inst.config.lastIngestion) {
          console.log(`Last ingest:  ${inst.config.lastIngestion}`);
        }
        console.log('');
      }
    });
}
