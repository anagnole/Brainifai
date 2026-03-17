# Phase 3: Multi-Instance Kuzu

## Goal
Move from a single global Kuzu database to per-project Kuzu instances. The global instance maintains a registry of all children as nodes in its graph.

## Dependencies
- Phase 2 (CLI and instance model exist)

## Steps
1. Each instance gets its own Kuzu DB at its `.brainifai/` directory
2. Define the schema for child instance nodes in the global graph (name, type, description, path, metadata)
3. On child init, register the child as a node in the parent's graph
4. Keep child descriptions in sync — when a description updates, the parent node updates too
5. Global instance can list and query its registry of children
6. Handle edge cases — what happens when a child is deleted, moved, or renamed?

## Tickets
- [017-per-instance-kuzu-db](../tickets/017-per-instance-kuzu-db.md)
- [018-child-registry-schema](../tickets/018-child-registry-schema.md)
- [019-child-registration-flow](../tickets/019-child-registration-flow.md)
- [020-description-sync](../tickets/020-description-sync.md)
- [021-registry-query-api](../tickets/021-registry-query-api.md)
- [022-instance-lifecycle-edge-cases](../tickets/022-instance-lifecycle-edge-cases.md)
