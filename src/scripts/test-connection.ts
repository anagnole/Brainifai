import { getDriver, closeDriver } from '../shared/neo4j.js';

async function main() {
  const driver = getDriver();
  const info = await driver.getServerInfo();
  console.log('Connected to Neo4j');
  console.log(`  Address: ${info.address}`);
  console.log(`  Version: ${info.protocolVersion}`);
  await closeDriver();
}

main().catch((err) => {
  console.error('Connection failed:', err.message);
  process.exit(1);
});
