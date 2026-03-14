import { Command } from 'commander';
import { globalInstanceExists } from '../../instance/resolve.js';
import { checkAllInstances } from '../../instance/lifecycle.js';

export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Check health of all registered instances')
    .action(async () => {
      if (!globalInstanceExists()) {
        console.log('No global instance found. Run `brainifai init` first.');
        return;
      }

      const results = await checkAllInstances();
      if (results.length === 0) {
        console.log('No instances registered.');
        return;
      }

      let hasIssues = false;
      for (const r of results) {
        const status = r.issues.length === 0 ? 'OK' : 'ISSUE';
        console.log(`[${status}] ${r.instance.name} (${r.instance.type})`);
        for (const issue of r.issues) {
          hasIssues = true;
          console.log(`  - ${issue}`);
        }
      }

      if (!hasIssues) {
        console.log('\nAll instances healthy.');
      }
    });
}
