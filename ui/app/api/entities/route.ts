import { NextRequest, NextResponse } from 'next/server'
import { runQuery } from '@/lib/neo4j'
import neo4j from '@/lib/neo4j'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)

  // Stats endpoint
  if (searchParams.get('stats') === 'true') {
    try {
      const [people, topics, containers, activities] = await Promise.all([
        runQuery('MATCH (n:Person) RETURN count(n) AS count'),
        runQuery('MATCH (n:Topic) RETURN count(n) AS count'),
        runQuery('MATCH (n:Container) RETURN count(n) AS count'),
        runQuery('MATCH (n:Activity) RETURN count(n) AS count'),
      ])
      return NextResponse.json({
        people: people[0]?.get('count').toNumber() ?? 0,
        topics: topics[0]?.get('count').toNumber() ?? 0,
        containers: containers[0]?.get('count').toNumber() ?? 0,
        activities: activities[0]?.get('count').toNumber() ?? 0,
      })
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 })
    }
  }

  // Search or browse endpoint
  const q = searchParams.get('q') || ''
  const type = searchParams.get('type') || ''
  const limit = parseInt(searchParams.get('limit') || '48', 10)

  try {
    let records
    if (q.trim()) {
      // Fulltext search with fuzzy matching
      const safeQ = q.replace(/[+\-&|!(){}[\]^"~*?:\\\/]/g, '\\$&')
      const fuzzyQ = safeQ.split(/\s+/).map((w) => `${w}~`).join(' ')

      let cypher = `
        CALL db.index.fulltext.queryNodes('entity_search', $query)
        YIELD node, score
        WHERE score > 0.3
      `
      if (type) cypher += ` AND node:${type}`
      cypher += `
        RETURN
          CASE WHEN node:Person THEN node.person_key
               WHEN node:Container THEN node.source + ':' + node.container_id
               ELSE node.name END AS id,
          head(labels(node)) AS type,
          coalesce(node.display_name, node.name) AS name,
          score
        ORDER BY score DESC LIMIT $limit
      `
      records = await runQuery(cypher, { query: fuzzyQ, limit: neo4j.int(limit) })
    } else {
      // Browse mode — return all entities ordered by label then name
      const labelFilter = type ? `WHERE node:${type}` : ''
      const cypher = `
        MATCH (node) WHERE node:Person OR node:Topic OR node:Container
        ${labelFilter ? `AND node:${type}` : ''}
        RETURN
          CASE WHEN node:Person THEN node.person_key
               WHEN node:Container THEN node.source + ':' + node.container_id
               ELSE node.name END AS id,
          head(labels(node)) AS type,
          coalesce(node.display_name, node.name) AS name,
          1.0 AS score
        ORDER BY type, name LIMIT $limit
      `
      records = await runQuery(cypher, { limit: neo4j.int(limit) })
    }

    const results = records.map((r) => ({
      id: r.get('id'),
      type: r.get('type'),
      name: r.get('name'),
      score: r.get('score'),
    }))
    return NextResponse.json({ results })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
