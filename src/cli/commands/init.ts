import { Command } from 'commander';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { initGlobalInstance, initProjectInstance } from '../../instance/init.js';
import { runInteractiveInit } from '../../instance/init-interactive.js';
import { listTemplateNames } from '../../instance/templates.js';

export function initCommand(): Command {
  return new Command('init')
    .description('Initialize a Brainifai instance')
    .option('--global', 'Create the global instance at ~/.brainifai/')
    .option('--type <type>', `Instance type (${listTemplateNames().join(', ')})`)
    .option('--workdir <path>', 'Folder this instance covers (default: cwd)')
    .option('--name <name>', 'Instance name (default: <foldername>-<type>)')
    .option('--description <desc>', 'Override description (default: LLM-generated)')
    .option('--domain <domain>', 'Research domain (for researcher type)')
    .option('--populate', 'Run the template\'s populate script after init')
    .action(async (opts) => {
      try {
        if (opts.global) {
          const path = await initGlobalInstance({ type: opts.type });
          console.log(`✓ Global instance created at ${path}`);
          return;
        }

        // Flag-driven init when enough info is provided
        if (opts.type) {
          const result = await initProjectInstance({
            workdir: resolve(opts.workdir ?? process.cwd()),
            type: opts.type,
            name: opts.name,
            description: opts.description,
            populate: Boolean(opts.populate),
            domain: opts.domain,
          });
          console.log(`✓ Instance "${result.instance.name}" created`);
          console.log(`  folder: ${result.folderPath}`);
          console.log(`  db:     ${result.dbPath}`);
          return;
        }

        // Interactive flow
        if (isAtHome()) {
          console.error('Refusing to init a project instance in $HOME. Use --global to init the global instance, or `cd` into a project folder.');
          process.exitCode = 1;
          return;
        }

        const result = await runInteractiveInit();
        if (!result) {
          console.log('Aborted.');
          process.exitCode = 1;
          return;
        }
        console.log(`✓ Instance "${result.instanceName}" created`);
        console.log(`  folder: ${result.folderPath}`);
        console.log(`  db:     ${result.dbPath}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}

function isAtHome(): boolean {
  return process.cwd() === homedir();
}
