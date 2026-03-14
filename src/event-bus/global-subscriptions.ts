// ─── Default event handlers for the global instance ─────────────────────────

import type { EventBus, EventEnvelope } from './types.js';
import type { InstanceRegisteredData, InstanceUpdatedData } from './messages.js';
import { logger } from '../shared/logger.js';

export function registerGlobalSubscriptions(bus: EventBus): void {
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

  // Handle query requests targeted at global
  bus.subscribe(['query.request'], async (event: EventEnvelope) => {
    if (event.target === 'global' || !event.target) {
      logger.info({ data: event.data }, '[event-bus] Query request received');
    }
  });
}
