import { Command } from 'commander';
import { createInterface } from 'readline/promises';
import { basename } from 'path';
import { homedir } from 'os';
import { globalInstanceExists } from '../../instance/resolve.js';
import { initGlobalInstance, initProjectInstance } from '../../instance/init.js';
import { listTemplateNames } from '../../instance/templates.js';

export function initCommand(): Command {
  const cmd = new Command('init')
    .description('Initialize a Brainifai instance')
    .option('--global', 'Force global instance creation')
    .option('--type <type>', 'Instance type (coding, manager, general)')
    .option('--name <name>', 'Instance name')
    .option('--description <desc>', 'Instance description')
    .action(async (opts) => {
      const isGlobal = opts.global || !isInsideProject();

      if (isGlobal) {
        try {
          const path = await initGlobalInstance({ type: opts.type });
          console.log(`✓ Global instance created at ${path}`);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      } else {
        // Project init — only prompt interactively for missing fields
        const needsPrompt = !opts.name || !opts.type;
        let rl: ReturnType<typeof createInterface> | null = null;

        try {
          if (needsPrompt && process.stdin.isTTY) {
            rl = createInterface({ input: process.stdin, output: process.stdout });
          }

          const name = opts.name ?? (
            rl
              ? (await rl.question(`Instance name [${basename(process.cwd())}]: `) || basename(process.cwd()))
              : basename(process.cwd())
          );

          const type = opts.type ?? (
            rl
              ? (await rl.question(`Instance type (${listTemplateNames().join(', ')}) [coding]: `) || 'coding')
              : 'coding'
          );

          const description = opts.description; // undefined triggers auto-generation

          rl?.close();

          const path = await initProjectInstance({
            name,
            type,
            description,
            projectPath: process.cwd(),
          });
          console.log(`✓ Project instance "${name}" created at ${path}`);
        } catch (err) {
          rl?.close();
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }
    });

  return cmd;
}

function isInsideProject(): boolean {
  const cwd = process.cwd();
  const home = homedir();
  return cwd !== home && cwd !== '/';
}
