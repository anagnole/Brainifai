import { Command } from 'commander';
import { resolve } from 'path';
import { homedir } from 'os';
import { getInstanceByName } from '../../instance/registry.js';
import { readInstanceConfig } from '../../instance/resolve.js';
import { runProjectManagerIngestion } from '../../ingestion/project-manager/index.js';
import { runResearcherIngestion } from '../../ingestion/researcher-pipeline/index.js';

const SUPPORTED_TYPES = ['project-manager', 'researcher'];

export function ingestCommand(): Command {
  return new Command('ingest')
    .description('Run ingestion for a Brainifai instance')
    .requiredOption('--instance <name>', 'Instance name to populate (type: project-manager or researcher)')
    .option('--projects-dir <dir>', 'Directory to scan for git repos', resolve(homedir(), 'Projects'))
    .option('--verbose', 'Print detailed progress for each phase')
    .option('--force', 'Clear all existing data and do a full re-index')
    .option('--extract-only', 'Skip fetching, run LLM extraction on existing tweets (researcher only)')
    .action(async (opts) => {
      const { instance: instanceName, projectsDir, verbose, force, extractOnly } = opts as {
        instance: string;
        projectsDir: string;
        verbose: boolean;
        force: boolean;
        extractOnly: boolean;
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

      if (!SUPPORTED_TYPES.includes(entry.type)) {
        console.error(`Error: instance "${instanceName}" is type "${entry.type}", not one of: ${SUPPORTED_TYPES.join(', ')}.`);
        console.error('Only project-manager and researcher instances support the ingest command.');
        process.exitCode = 1;
        return;
      }

      if (entry.status === 'removed') {
        console.error(`Error: instance "${instanceName}" has been removed.`);
        process.exitCode = 1;
        return;
      }

      const dbPath = resolve(entry.path, 'data', 'kuzu');

      // ── Project Manager ingestion ────────────────────────────────────────
      if (entry.type === 'project-manager') {
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
        return;
      }

      // ── Researcher ingestion ─────────────────────────────────────────────
      if (entry.type === 'researcher') {
        // Read instance config to get the domain field
        let domain: string | undefined;
        try {
          const config = readInstanceConfig(entry.path);
          domain = config.domain;
        } catch {
          // Config may not exist — domain will default inside the pipeline
        }

        if (!verbose) {
          console.log(`Ingesting into instance "${instanceName}" (${entry.path})`);
          console.log(`Domain: ${domain ?? '(default)'}`);
          if (force) console.log('Force mode: clearing existing data first');
        }

        try {
          const stats = await runResearcherIngestion({
            dbPath,
            domain,
            verbose,
            force,
            extractOnly,
          });

          const secs = (stats.durationMs / 1000).toFixed(1);
          console.log('');
          console.log('✓ Ingestion complete');
          console.log(`  Tweets      : ${stats.tweets}`);
          console.log(`  Entities    : ${stats.entities}`);
          console.log(`  Events      : ${stats.events}`);
          console.log(`  Trends      : ${stats.trends}`);
          console.log(`  Duration    : ${secs}s`);

          // Exit cleanly to avoid Kuzu segfaults on process teardown
          process.exit(0);
        } catch (err) {
          console.error(`Error: ingestion failed — ${(err as Error).message}`);
          if (verbose) console.error((err as Error).stack);
          process.exitCode = 1;
        }
      }
    });
}
