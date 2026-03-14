// ─── Event Bus core types ───────────────────────────────────────────────────

import type { EVENT_KINDS } from './constants.js';

export type EventKind = (typeof EVENT_KINDS)[number];

export type DeliveryGuarantee = 'best-effort' | 'at-least-once';

export interface EventEnvelope<T = unknown> {
  id: string;                    // ulid — sortable, unique
  kind: EventKind;               // e.g. 'instance.registered'
  source: string;                // instance name that emitted
  target?: string;               // specific instance, or undefined = broadcast
  timestamp: string;             // ISO 8601
  data: T;
  replyTo?: string;              // id of event this responds to (for query/response)
}

export type EventHandler<T = unknown> = (event: EventEnvelope<T>) => void | Promise<void>;

export interface Subscription {
  id: string;
  kinds: EventKind[] | '*';      // '*' = all events
  instance?: string;             // filter by source instance
  handler: EventHandler;
}

export interface EventBus {
  publish(event: Omit<EventEnvelope, 'id' | 'timestamp'>): Promise<string>;
  subscribe(kinds: EventKind[] | '*', handler: EventHandler): Subscription;
  unsubscribe(subscriptionId: string): void;
  replay(opts?: { since?: string; kinds?: EventKind[] }): Promise<EventEnvelope[]>;
  close(): Promise<void>;
}
