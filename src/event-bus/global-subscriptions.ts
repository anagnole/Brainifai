// ─── Default event handlers for the global instance ─────────────────────────

import type { EventBus, EventEnvelope } from './types.js';
import type { InstanceRegisteredData, InstanceUpdatedData, QueryRequestData } from './messages.js';
import { sendQueryResponse } from './helpers.js';
import { logger } from '../shared/logger.js';

export function registerGlobalSubscriptions(bus: EventBus, instanceName?: string): void {
  const myName = instanceName ?? 'global';

  // Log all events
  bus.subscribe('*', async (event: EventEnvelope) => {
    logger.info({ eventId: event.id, kind: event.kind, source: event.source }, '[event-bus] event received');
  });

  // Handle new instance registrations
  bus.subscribe(['instance.registered'], async (event) => {
    const { name, type, path } = event.data as InstanceRegisteredData;
    logger.info(`[event-bus] New instance registered: ${name} (${type}) at ${path}`);
  });

  // Handle instance updates — cross-process sync
  bus.subscribe(['instance.updated'], async (event) => {
    const { name, fields } = event.data as InstanceUpdatedData;
    if (fields.description) {
      logger.info(`[event-bus] Instance "${name}" description updated`);
    }
  });

  // Handle query requests targeted at this instance
  bus.subscribe(['query.request'], async (event: EventEnvelope) => {
    if (event.target !== myName) return;
    // Don't respond to our own queries (cycle prevention)
    if (event.source === myName) return;

    const data = event.data as QueryRequestData;
    logger.info({ data, from: event.source }, '[event-bus] Query request received, executing');

    try {
      const { getGraphStore } = await import('../shared/graphstore.js');
      const store = await getGraphStore();

      let results: unknown;

      if (data.queryType === 'context') {
        // Run a context packet query
        const { buildContextPacket } = await import('../mcp/queries/context-packet.js');
        results = await buildContextPacket(data.query, 30, 10);
      } else if (data.queryType === 'search') {
        results = await store.search({ query: data.query, limit: 10 });
      } else if (data.queryType === 'activity') {
        const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
        results = await store.getRecentActivity({ since, limit: 10 });
      } else {
        results = { error: `Unknown query type: ${data.queryType}` };
      }

      await sendQueryResponse(myName, event.id, { results });
    } catch (err) {
      logger.warn({ err, eventId: event.id }, '[event-bus] Query execution failed');
      await sendQueryResponse(myName, event.id, {
        results: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
