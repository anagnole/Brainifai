// ─── Typed convenience emitters ─────────────────────────────────────────────
// All helpers are fire-and-forget: silently no-op if the bus isn't initialized.

import { getEventBus } from './index.js';
import type { InstanceRegisteredData, InstanceUpdatedData, InstanceRemovedData, QueryRequestData, DataPushData } from './messages.js';

export async function emitInstanceRegistered(source: string, data: InstanceRegisteredData): Promise<void> {
  const bus = getEventBus();
  if (bus) await bus.publish({ kind: 'instance.registered', source, data });
}

export async function emitInstanceUpdated(source: string, data: InstanceUpdatedData): Promise<void> {
  const bus = getEventBus();
  if (bus) await bus.publish({ kind: 'instance.updated', source, data });
}

export async function emitInstanceRemoved(source: string, data: InstanceRemovedData): Promise<void> {
  const bus = getEventBus();
  if (bus) await bus.publish({ kind: 'instance.removed', source, data });
}

export async function sendQuery(
  source: string,
  target: string,
  data: QueryRequestData,
): Promise<string> {
  const bus = getEventBus();
  if (!bus) throw new Error('Event bus not initialized');
  return bus.publish({ kind: 'query.request', source, target, data });
}

export async function sendQueryResponse(
  source: string,
  replyTo: string,
  data: unknown,
): Promise<void> {
  const bus = getEventBus();
  if (bus) await bus.publish({ kind: 'query.response', source, data, replyTo });
}

export async function emitDataPush(
  source: string,
  target: string,
  data: DataPushData,
): Promise<void> {
  const bus = getEventBus();
  if (bus) await bus.publish({ kind: 'data.push', source, target, data });
}
