# Phase 4: Event Bus

## Goal
Build the inter-instance messaging system that allows instances to communicate — registration, updates, queries, and responses.

## Dependencies
- Phase 3 (multi-instance Kuzu is working, registry exists)

## Steps
1. Design the event bus protocol — message types, format, delivery guarantees
2. Define core message types:
   - `instance.registered` — new instance announces itself
   - `instance.updated` — instance description or config changed
   - `query.request` — an instance asks for information
   - `query.response` — an instance responds with data
   - `data.push` — parent pushes ingested data to a child
3. Implement the event bus transport (local IPC, file-based, or lightweight queue — TBD)
4. Instances can publish and subscribe to events
5. Global instance subscribes to all events by default
6. Test basic message flow: child registers → parent receives → parent queries child → child responds

## Tickets
- [023-event-bus-protocol-design](../tickets/023-event-bus-protocol-design.md)
- [024-define-message-types](../tickets/024-define-message-types.md)
- [025-implement-event-bus-transport](../tickets/025-implement-event-bus-transport.md)
- [026-publish-subscribe-api](../tickets/026-publish-subscribe-api.md)
- [027-global-default-subscriptions](../tickets/027-global-default-subscriptions.md)
- [028-integration-test-message-flow](../tickets/028-integration-test-message-flow.md)
