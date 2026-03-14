import { Command } from 'commander';
import { globalInstanceExists, readInstanceConfig, GLOBAL_BRAINIFAI_PATH } from '../../instance/resolve.js';
import { listInstances, searchInstances } from '../../instance/registry.js';
import type { InstanceRegistryEntry } from '../../instance/types.js';

export function listCommand(): Command {
  return new Command('list')
    .description('List all known instances in the tree')
    .option('--type <type>', 'Filter by instance type')
    .option('--query <query>', 'Search instances by description')
    .action(async (opts: { type?: string; query?: string }) => {
      if (!globalInstanceExists()) {
        console.log('No global instance found. Run `brainifai init` first.');
        return;
      }

      const globalConfig = readInstanceConfig(GLOBAL_BRAINIFAI_PATH);
      console.log(`● ${globalConfig.name} (${globalConfig.type}) — ${GLOBAL_BRAINIFAI_PATH}`);
      console.log(`  ${globalConfig.description}`);

      let children: InstanceRegistryEntry[];
      if (opts.query) {
        children = await searchInstances(opts.query);
      } else {
        children = await listInstances({ status: 'active' });
      }

      if (opts.type) {
        children = children.filter(c => c.type === opts.type);
      }

      // Exclude the global node from children list
      children = children.filter(c => c.name !== 'global');

      if (children.length === 0) {
        console.log('\n  No child instances found.');
        return;
      }

      for (const child of children) {
        const statusTag = child.status !== 'active' ? ` [${child.status}]` : '';
        console.log(`  ├─ ${child.name} (${child.type})${statusTag} — ${child.path}`);
        console.log(`  │  ${child.description}`);
      }
    });
}
