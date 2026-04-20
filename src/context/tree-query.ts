// ─── Tree Traversal Query Coordinator ────────────────────────────────────────
// Enables cross-instance queries via the event bus.

import { sendQuery, sendQueryResponse } from '../event-bus/helpers.js';
import { getEventBus } from '../event-bus/index.js';
import type { EventEnvelope } from '../event-bus/types.js';
import type { QueryResponseData } from '../event-bus/messages.js';
import { dirname } from 'node:path';
import { readFolderConfigAt } from '../instance/resolve.js';
import { findInstance } from '../instance/folder-config.js';
import { searchInstances, listInstances } from '../instance/registry.js';
import { logger } from '../shared/logger.js';

const DEFAULT_TREE_QUERY_TIMEOUT = 5000;

export interface TreeQueryResult {
  instance: string;
  results: unknown;
  source: 'local' | 'remote';
}

/**
 * Query up the tree: send query.request to parent via event bus,
 * wait for query.response with timeout.
 */
export async function queryParent(
  query: string,
  instanceName: string,
  instancePath: string,
  timeout: number = DEFAULT_TREE_QUERY_TIMEOUT,
): Promise<TreeQueryResult | null> {
  const bus = getEventBus();
  if (!bus) {
    logger.debug('Event bus not initialized, skipping parent query');
    return null;
  }

  // Read instance config to find parent. v2: instancePath is <folder>/.brainifai/<name>/;
  // its FolderConfig is one directory up.
  let parentName: string | null;
  try {
    const folderPath = dirname(instancePath);
    const folderCfg = readFolderConfigAt(folderPath);
    const inst = folderCfg ? findInstance(folderCfg, instanceName) : null;
    parentName = inst?.parent ?? null;
  } catch {
    return null;
  }

  if (!parentName) return null;

  // Subscribe for response BEFORE publishing request (race prevention)
  return new Promise<TreeQueryResult | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        bus.unsubscribe(sub.id);
        logger.debug({ query, parent: parentName }, 'Parent query timed out');
        resolve(null);
      }
    }, timeout);

    const sub = bus.subscribe(['query.response'], (event: EventEnvelope) => {
      if (settled) return;
      // Match by replyTo
      if (event.replyTo === requestId && event.source === parentName) {
        settled = true;
        clearTimeout(timer);
        bus.unsubscribe(sub.id);
        const data = event.data as QueryResponseData;
        if (data.error) {
          logger.warn({ error: data.error }, 'Parent query returned error');
          resolve(null);
        } else {
          resolve({ instance: parentName!, results: data.results, source: 'remote' });
        }
      }
    });

    // Send the request
    let requestId: string;
    sendQuery(instanceName, parentName!, {
      queryType: 'context',
      query,
    }).then((id) => {
      requestId = id;
    }).catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        bus.unsubscribe(sub.id);
        logger.warn({ err }, 'Failed to send parent query');
        resolve(null);
      }
    });
  });
}

/**
 * Query down the tree: parent finds relevant children by description match,
 * sends query.request to each, aggregates responses.
 */
export async function queryChildren(
  query: string,
  instanceName: string,
  timeout: number = DEFAULT_TREE_QUERY_TIMEOUT,
): Promise<TreeQueryResult[]> {
  const bus = getEventBus();
  if (!bus) return [];

  // Find relevant children by description search
  let children;
  try {
    children = await searchInstances(query);
    // Filter to only active children of this instance
    if (children.length === 0) {
      const allChildren = await listInstances({ status: 'active' });
      children = allChildren.filter((c) => c.parent === instanceName);
    } else {
      children = children.filter((c) => c.parent === instanceName && c.status === 'active');
    }
  } catch {
    return [];
  }

  if (children.length === 0) return [];

  // Fan out queries to relevant children
  const results: TreeQueryResult[] = [];
  const pending = new Map<string, string>(); // requestId → childName

  return new Promise<TreeQueryResult[]>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        bus.unsubscribe(sub.id);
        resolve(results);
      }
    }, timeout);

    const sub = bus.subscribe(['query.response'], (event: EventEnvelope) => {
      if (settled) return;
      const childName = pending.get(event.replyTo ?? '');
      if (childName) {
        const data = event.data as QueryResponseData;
        if (!data.error) {
          results.push({ instance: childName, results: data.results, source: 'remote' });
        }
        pending.delete(event.replyTo!);
        // If all responses received, resolve early
        if (pending.size === 0) {
          settled = true;
          clearTimeout(timer);
          bus.unsubscribe(sub.id);
          resolve(results);
        }
      }
    });

    // Send requests in parallel
    Promise.all(
      children.map(async (child) => {
        try {
          const id = await sendQuery(instanceName, child.name, {
            queryType: 'context',
            query,
          });
          pending.set(id, child.name);
        } catch (err) {
          logger.warn({ err, child: child.name }, 'Failed to send child query');
        }
      }),
    ).then(() => {
      // If no requests were sent, resolve immediately
      if (pending.size === 0 && !settled) {
        settled = true;
        clearTimeout(timer);
        bus.unsubscribe(sub.id);
        resolve(results);
      }
    });
  });
}
