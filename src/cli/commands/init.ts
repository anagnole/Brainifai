import { Command } from 'commander';
import { createInterface } from 'readline/promises';
import { basename, resolve as resolvePath } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { globalInstanceExists } from '../../instance/resolve.js';
import { initGlobalInstance, initProjectInstance } from '../../instance/init.js';
import { listTemplateNames } from '../../instance/templates.js';

// Resolve the Brainifai repo root (two levels up from src/cli/commands/)
const BRAINIFAI_ROOT = resolvePath(fileURLToPath(import.meta.url), '..', '..', '..', '..');

export function initCommand(): Command {
  const cmd = new Command('init')
    .description('Initialize a Brainifai instance')
    .option('--global', 'Force global instance creation')
    .option('--type <type>', 'Instance type (coding, manager, general, project-manager)')
    .option('--name <name>', 'Instance name')
    .option('--description <desc>', 'Instance description')
    .option('--force', 'Re-initialize even if instance already exists (deletes existing data)')
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

          const instancePath = await initProjectInstance({
            name,
            type,
            description,
            projectPath: process.cwd(),
            force: opts.force,
          });
          console.log(`✓ Project instance "${name}" created at ${instancePath}`);

          // For project-manager: run ingestion in a child process to avoid
          // Kuzu native state pollution from the init process (double-open segfault).
          if (type === 'project-manager') {
            console.log('Running project-manager ingestion pipeline...');
            const dbPath = resolvePath(instancePath, 'data', 'kuzu');
            const projectsDir = process.cwd();
            const ingestScript = [
              `import { runProjectManagerIngestion } from '${resolvePath(BRAINIFAI_ROOT, 'src/ingestion/project-manager/index.js')}';`,
              `const stats = await runProjectManagerIngestion({`,
              `  dbPath: ${JSON.stringify(dbPath)},`,
              `  projectsDir: ${JSON.stringify(projectsDir)},`,
              `  verbose: true,`,
              `  force: false,`,
              `});`,
              `process.stdout.write(JSON.stringify(stats) + '\\n');`,
            ].join('\n');

            const tsx = resolvePath(BRAINIFAI_ROOT, 'node_modules/.bin/tsx');
            const output = execSync(`${tsx} --input-type=module`, {
              input: ingestScript,
              stdio: ['pipe', 'pipe', 'inherit'],
              cwd: BRAINIFAI_ROOT,
              encoding: 'utf-8',
            });
            const stats = JSON.parse(output.trim().split('\n').pop()!);
            console.log(
              `✓ Ingestion complete: ${stats.projects} projects, ${stats.commits} commits, ` +
              `${stats.dependencies} deps, ${stats.sessions} sessions (${stats.durationMs}ms)`,
            );

            // Regenerate skill with populated DB
            const { generateInstanceSkill } = await import('../../instance/skill-generator.js');
            const { generateDescription } = await import('../../instance/descriptions.js');
            const { getTemplate } = await import('../../instance/templates.js');
            const template = getTemplate(type);
            const desc = description ?? generateDescription(name, type, template?.sources ?? []);
            generateInstanceSkill({ instancePath, projectPath: process.cwd(), name, type, description: desc });
            console.log(`✓ Skill generated at ${resolvePath(process.cwd(), '.claude', 'skills', 'brainifai', 'SKILL.md')}`);
          }
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
