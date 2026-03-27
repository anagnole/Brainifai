import { Command } from 'commander';
import { createInterface } from 'readline/promises';
import { basename, resolve as resolvePath } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
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
            const tmpScript = resolvePath(BRAINIFAI_ROOT, '.tmp-ingest.mts');
            writeFileSync(tmpScript, [
              `import { runProjectManagerIngestion } from './src/ingestion/project-manager/index.js';`,
              `const stats = await runProjectManagerIngestion({`,
              `  dbPath: ${JSON.stringify(dbPath)},`,
              `  projectsDir: ${JSON.stringify(projectsDir)},`,
              `  verbose: true,`,
              `  force: false,`,
              `});`,
              `process.stdout.write('__STATS__' + JSON.stringify(stats) + '\\n');`,
              `process.exit(0);`,
            ].join('\n'));

            try {
              const tsx = resolvePath(BRAINIFAI_ROOT, 'node_modules/.bin/tsx');
              const output = execSync(`${tsx} ${tmpScript}`, {
                stdio: ['ignore', 'pipe', 'inherit'],
                cwd: BRAINIFAI_ROOT,
                encoding: 'utf-8',
                timeout: 300_000, // 5 min max
              });
              const statsLine = output.split('\n').find(l => l.startsWith('__STATS__'));
              if (statsLine) {
                const stats = JSON.parse(statsLine.replace('__STATS__', ''));
                console.log(
                  `✓ Ingestion complete: ${stats.projects} projects, ${stats.commits} commits, ` +
                  `${stats.dependencies} deps, ${stats.sessions} sessions (${(stats.durationMs / 1000).toFixed(1)}s)`,
                );
              }
            } catch (execErr: any) {
              // Exit 139 (segfault on Kuzu cleanup) is OK if ingestion actually completed
              if (execErr.stdout && execErr.stdout.includes('__STATS__')) {
                const statsLine = execErr.stdout.split('\n').find((l: string) => l.startsWith('__STATS__'));
                if (statsLine) {
                  const stats = JSON.parse(statsLine.replace('__STATS__', ''));
                  console.log(
                    `✓ Ingestion complete: ${stats.projects} projects, ${stats.commits} commits, ` +
                    `${stats.dependencies} deps, ${stats.sessions} sessions (${(stats.durationMs / 1000).toFixed(1)}s)`,
                  );
                }
              } else {
                console.error('Ingestion failed:', execErr.message);
              }
            } finally {
              try { unlinkSync(tmpScript); } catch {}
            }

            // Regenerate skill with populated DB
            const { generateInstanceSkill } = await import('../../instance/skill-generator.js');
            const { generateDescription: genDesc } = await import('../../instance/descriptions.js');
            const { getTemplate: getTempl } = await import('../../instance/templates.js');
            const tmpl = getTempl(type);
            const desc = description ?? genDesc(name, type, tmpl?.sources ?? []);
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
