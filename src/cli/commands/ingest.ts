import { Command } from 'commander';
import { resolve } from 'path';
import { homedir } from 'os';
import { getInstanceByName } from '../../instance/registry.js';
import { runProjectManagerIngestion } from '../../ingestion/project-manager/index.js';

export function ingestCommand(): Command {
  return new Command('ingest')
    .description('Run ingestion for a Brainifai instance')
    .requiredOption('--instance <name>', 'Instance name to populate (must be type: project-manager)')
    .option('--projects-dir <dir>', 'Directory to scan for git repos', resolve(homedir(), 'Projects'))
    .option('--verbose', 'Print detailed progress for each phase')
    .option('--force', 'Clear all existing data and do a full re-index')
    .action(async (opts) => {
      const { instance: instanceName, projectsDir, verbose, force } = opts as {
        instance: string;
        projectsDir: string;
        verbose: boolean;
        force: boolean;
      };

      // Look up the instance in the global registry
      let entry;
      try {
        entry = await getInstanceByName(instanceName);
      } catch (err) {
        console.error(`Error: could not read global registry — ${(err as Error).message}`);
        console.error('Run `brainifai init` to set up the global instance first.');
        process.exitCode = 1;
        return;
      }

      if (!entry) {
        console.error(`Error: instance "${instanceName}" not found.`);
        console.error('Run `brainifai list` to see available instances.');
        process.exitCode = 1;
        return;
      }

      if (entry.type !== 'project-manager') {
        console.error(`Error: instance "${instanceName}" is type "${entry.type}", not "project-manager".`);
        console.error('Only project-manager instances support the ingest command.');
        process.exitCode = 1;
        return;
      }

      if (entry.status === 'removed') {
        console.error(`Error: instance "${instanceName}" has been removed.`);
        process.exitCode = 1;
        return;
      }

      const dbPath = resolve(entry.path, 'data', 'kuzu');

      if (!verbose) {
        console.log(`Ingesting into instance "${instanceName}" (${entry.path})`);
        console.log(`Scanning: ${projectsDir}`);
        if (force) console.log('Force mode: clearing existing data first');
      }

      try {
        const stats = await runProjectManagerIngestion({
          dbPath,
          projectsDir,
          verbose,
          force,
        });

        const secs = (stats.durationMs / 1000).toFixed(1);
        console.log('');
        console.log('✓ Ingestion complete');
        console.log(`  Projects    : ${stats.projects}`);
        console.log(`  Commits     : ${stats.commits}`);
        console.log(`  Branches    : ${stats.branches}`);
        console.log(`  Dependencies: ${stats.dependencies}`);
        console.log(`  Relations   : ${stats.relations}`);
        console.log(`  Sessions    : ${stats.sessions}`);
        console.log(`  Duration    : ${secs}s`);
      } catch (err) {
        console.error(`Error: ingestion failed — ${(err as Error).message}`);
        if (verbose) console.error((err as Error).stack);
        process.exitCode = 1;
      }
    });
}
