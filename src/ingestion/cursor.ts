import type { GraphStore } from '../graphstore/types.js';

/**
 * Get the latest processed ts for a source/container.
 * Returns null if no cursor exists (triggers backfill).
 */
export async function getCursor(
  store: GraphStore,
  source: string,
  containerId: string,
): Promise<string | null> {
  return store.getCursor(source, containerId);
}

/**
 * Update the cursor after a successful batch.
 */
export async function setCursor(
  store: GraphStore,
  source: string,
  containerId: string,
  latestTs: string,
): Promise<void> {
  return store.setCursor(source, containerId, latestTs);
}
