import { seedSchema } from '../shared/schema.js';
import { closeDriver } from '../shared/neo4j.js';

async function main() {
  await seedSchema();
  console.log('Schema seeded successfully');
  await closeDriver();
}

main().catch((err) => {
  console.error('Schema seed failed:', err.message);
  process.exit(1);
});
