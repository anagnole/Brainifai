import { getGraphStore, closeGraphStore } from '../shared/graphstore.js';

process.env.GRAPHSTORE_READONLY = 'true';

async function main() {
  const store = await getGraphStore();
  await store.initialize();

  const [persons, activities, topics, containers, cursors] = await Promise.all([
    store.findNodes('Person', {}, { limit: 10000 }),
    store.findNodes('Activity', {}, { limit: 10000 }),
    store.findNodes('Topic', {}, { limit: 10000 }),
    store.findNodes('Container', {}, { limit: 10000 }),
    store.findNodes('Cursor', {}, { limit: 100 }),
  ]);

  console.log('\n=== Graph Contents ===');
  console.log(`Persons:    ${persons.length}`);
  console.log(`Activities: ${activities.length}`);
  console.log(`Topics:     ${topics.length}`);
  console.log(`Containers: ${containers.length}`);

  if (persons.length) {
    console.log('\nSample people:');
    persons.slice(0, 8).forEach(p =>
      console.log(' ', p.properties.display_name || p.properties.person_key)
    );
  }

  if (containers.length) {
    console.log('\nContainers:');
    containers.forEach(c =>
      console.log(' ', `[${c.properties.source}]`, c.properties.name || c.properties.container_id)
    );
  }

  if (cursors.length) {
    console.log('\nIngestion cursors (last seen):');
    cursors
      .sort((a, b) => String(b.properties.latest_ts).localeCompare(String(a.properties.latest_ts)))
      .forEach(c =>
        console.log(' ', `${c.properties.source}/${c.properties.container_id}`, '→', c.properties.latest_ts)
      );
  } else {
    console.log('\nNo cursors — ingestion has not run yet.');
  }

  await closeGraphStore();
}

main().catch(err => { console.error(err.message); process.exit(1); });
