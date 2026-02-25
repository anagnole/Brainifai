import neo4j, { Driver, Record as Neo4jRecord } from 'neo4j-driver'
import { readEnv } from './env'

let _driver: Driver | null = null

export function getDriver(): Driver {
  if (_driver) return _driver
  const env = readEnv()
  const uri = env.NEO4J_URI || 'bolt://localhost:7687'
  const user = env.NEO4J_USER || 'neo4j'
  const password = env.NEO4J_PASSWORD || ''
  _driver = neo4j.driver(uri, neo4j.auth.basic(user, password))
  return _driver
}

export async function runQuery(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<Neo4jRecord[]> {
  const driver = getDriver()
  const session = driver.session()
  try {
    const result = await session.run(cypher, params)
    return result.records
  } finally {
    await session.close()
  }
}

export default neo4j
