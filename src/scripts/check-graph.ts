import { getGraphStore, closeGraphStore } from '../shared/graphstore.js';

async function main() {
  const store = await getGraphStore() as any;
  const conn = store.conn;

  async function q(cypher: string) {
    const r = await conn.query(cypher);
    return (Array.isArray(r) ? r[0] : r).getAll();
  }

  console.log('Activities:    ', (await q('MATCH (a:Activity) RETURN count(a) AS cnt'))[0].cnt);
  console.log('Persons:       ', (await q('MATCH (p:Person) RETURN count(p) AS cnt'))[0].cnt);
  console.log('Containers:    ', (await q('MATCH (c:Container) RETURN count(c) AS cnt'))[0].cnt);
  console.log('FROM_PERSON:   ', (await q('MATCH ()-[:FROM_PERSON]->() RETURN count(*) AS cnt'))[0].cnt);
  console.log('IN_CONTAINER:  ', (await q('MATCH ()-[:IN_CONTAINER]->() RETURN count(*) AS cnt'))[0].cnt);

  // Sample a raw activity
  const sample = await q('MATCH (a:Activity) RETURN a LIMIT 1');
  if (sample[0]) console.log('\nSample activity:', JSON.stringify(sample[0].a, null, 2));

  await closeGraphStore();
}
main().catch(console.error);
