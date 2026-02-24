import { getSession } from '../shared/neo4j.js';

/**
 * Get the latest processed Slack ts for a channel.
 * Returns null if no cursor exists (triggers backfill).
 */
export async function getCursor(
  source: string,
  containerId: string,
): Promise<string | null> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (cur:Cursor {source: $source, container_id: $containerId})
       RETURN cur.latest_ts AS latest_ts`,
      { source, containerId },
    );
    const record = result.records[0];
    return record ? (record.get('latest_ts') as string) : null;
  } finally {
    await session.close();
  }
}

/**
 * Update the cursor after a successful batch.
 * Stores the raw Slack ts string for direct use in API calls.
 */
export async function setCursor(
  source: string,
  containerId: string,
  latestTs: string,
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MERGE (cur:Cursor {source: $source, container_id: $containerId})
       SET cur.latest_ts = $latestTs, cur.updated_at = datetime()`,
      { source, containerId, latestTs },
    );
  } finally {
    await session.close();
  }
}
