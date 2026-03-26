#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { listCommand } from './commands/list.js';
import { describeCommand } from './commands/describe.js';
import { doctorCommand } from './commands/doctor.js';
import { removeCommand } from './commands/remove.js';
import { ingestCommand } from './commands/ingest.js';

const program = new Command();

program
  .name('brainifai')
  .description('Manage Brainifai knowledge graph instances')
  .version('0.2.0');

program.addCommand(initCommand());
program.addCommand(statusCommand());
program.addCommand(listCommand());
program.addCommand(describeCommand());
program.addCommand(doctorCommand());
program.addCommand(removeCommand());
program.addCommand(ingestCommand());

await program.parseAsync();
