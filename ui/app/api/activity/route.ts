import { NextRequest, NextResponse } from 'next/server'
import { runQuery } from '@/lib/neo4j'
import neo4j from '@/lib/neo4j'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)

  // Cursors endpoint
  if (searchParams.get('cursors') === 'true') {
    try {
      const records = await runQuery(
        'MATCH (cur:Cursor) RETURN cur.source, cur.container_id, cur.ts ORDER BY cur.ts DESC'
      )
      const cursors = records.map((r) => ({
        source: r.get('cur.source'),
        container_id: r.get('cur.container_id'),
        ts: r.get('cur.ts'),
      }))
      return NextResponse.json({ cursors })
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 })
    }
  }

  // Activity feed
  const personKey = searchParams.get('person_key') || ''
  const topic = searchParams.get('topic') || ''
  const containerId = searchParams.get('container_id') || ''
  const windowDays = parseInt(searchParams.get('window_days') || '30', 10)
  const limit = parseInt(searchParams.get('limit') || '20', 10)

  const windowStart = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000
  ).toISOString()

  const conditions: string[] = ['a.timestamp >= $windowStart']
  const params: Record<string, unknown> = {
    windowStart,
    limit: neo4j.int(limit),
  }

  if (personKey) {
    conditions.push('p.person_key = $personKey')
    params.personKey = personKey
  }
  if (topic) {
    conditions.push('EXISTS { (a)-[:MENTIONS]->(:Topic {name: $topic}) }')
    params.topic = topic
  }
  if (containerId) {
    conditions.push('c.container_id = $containerId')
    params.containerId = containerId
  }

  const whereClause = conditions.join(' AND ')

  const cypher = `
    MATCH (a:Activity)-[:FROM]->(p:Person), (a)-[:IN]->(c:Container)
    WHERE ${whereClause}
    RETURN a.timestamp, coalesce(p.display_name, p.person_key) AS person,
           c.name AS channel, a.kind, a.snippet, a.url, a.source
    ORDER BY a.timestamp DESC LIMIT $limit
  `

  try {
    const records = await runQuery(cypher, params)
    const activities = records.map((r) => ({
      timestamp: r.get('a.timestamp'),
      person: r.get('person'),
      channel: r.get('channel'),
      kind: r.get('a.kind'),
      snippet: r.get('a.snippet'),
      url: r.get('a.url'),
      source: r.get('a.source'),
    }))
    return NextResponse.json({ activities })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
