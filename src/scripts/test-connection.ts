import { getGraphStore, closeGraphStore } from '../shared/graphstore.js';

async function main() {
  const backend = process.env.GRAPHSTORE_BACKEND ?? 'kuzu';
  console.log(`Testing connection to ${backend} backend...`);

  const store = await getGraphStore();
  await store.initialize();

  // Verify we can read by checking node counts
  const people = await store.findNodes('Person', {}, { limit: 1 });
  const activities = await store.findNodes('Activity', {}, { limit: 1 });
  console.log(`Connected successfully`);
  console.log(`  Backend: ${backend}`);
  console.log(`  Has people: ${people.length > 0}`);
  console.log(`  Has activities: ${activities.length > 0}`);

  await closeGraphStore();
}

main().catch((err) => {
  console.error('Connection failed:', err.message);
  process.exit(1);
});
