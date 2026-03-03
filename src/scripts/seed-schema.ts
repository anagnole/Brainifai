import { getGraphStore, closeGraphStore } from '../shared/graphstore.js';

async function main() {
  const store = await getGraphStore();
  await store.initialize();
  console.log('Schema seeded successfully');
  await closeGraphStore();
}

main().catch((err) => {
  console.error('Schema seed failed:', err.message);
  process.exit(1);
});
