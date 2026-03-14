// ─── Event Bus singleton accessor ───────────────────────────────────────────

import { FileEventBus } from './transport.js';

let bus: FileEventBus | null = null;

export async function initEventBus(eventsDir?: string): Promise<FileEventBus> {
  if (!bus) {
    bus = new FileEventBus(eventsDir);
    await bus.init();
  }
  return bus;
}

export function getEventBus(): FileEventBus | null {
  return bus;
}

export async function closeEventBus(): Promise<void> {
  await bus?.close();
  bus = null;
}
