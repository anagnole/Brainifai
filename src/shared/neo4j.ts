import neo4j, { Driver, Session } from 'neo4j-driver';
import { logger } from './logger.js';

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
    const user = process.env.NEO4J_USER ?? 'neo4j';
    const password = process.env.NEO4J_PASSWORD;
    if (!password) {
      throw new Error('NEO4J_PASSWORD environment variable is required');
    }
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    logger.info({ uri, user }, 'Neo4j driver created');
  }
  return driver;
}

export function getSession(): Session {
  return getDriver().session();
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
    logger.info('Neo4j driver closed');
  }
}

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'Shutting down');
    await closeDriver();
    process.exit(0);
  });
}
