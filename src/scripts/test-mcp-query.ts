import { getGraphStore, closeGraphStore } from '../shared/graphstore.js';
import { getRecentActivity } from '../mcp/queries/activity.js';
import { searchEntities } from '../mcp/queries/search.js';

async function main() {
  console.log('GRAPHSTORE_READONLY:', process.env.GRAPHSTORE_READONLY);

  // Initialize like the MCP server does
  const store = await getGraphStore();
  await store.initialize();
  console.log('Store initialized\n');

  // Test getRecentActivity
  const activity = await getRecentActivity({ windowDays: 365, limit: 10 });
  console.log('getRecentActivity count:', activity.length);
  if (activity[0]) console.log('First:', JSON.stringify(activity[0], null, 2));

  // Test search
  const results = await searchEntities('mosaic', undefined, 5);
  console.log('\nsearchEntities count:', results.length);
  if (results[0]) console.log('First:', JSON.stringify(results[0], null, 2));

  await closeGraphStore();
}
main().catch(console.error);
