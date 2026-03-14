import { Command } from 'commander';
import { unregisterInstance } from '../../instance/registry.js';

export function removeCommand(): Command {
  return new Command('remove')
    .description('Remove an instance from the global registry')
    .argument('<name>', 'Instance name to remove')
    .action(async (name: string) => {
      const success = await unregisterInstance(name);
      if (success) {
        console.log(`Instance "${name}" marked as removed in registry.`);
      } else {
        console.error(`Failed to remove "${name}" — not found in registry.`);
        process.exitCode = 1;
      }
    });
}
