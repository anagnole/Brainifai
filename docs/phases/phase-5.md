# Phase 5: Orchestrator

## Goal
The global instance becomes an AI-powered orchestrator that is the sole ingester of external data and intelligently routes it to the appropriate child instances.

## Dependencies
- Phase 4 (event bus is working)

## Steps
1. Centralize all external source ingestion in the global instance — children never talk to Slack, GitHub, etc.
2. Build the orchestrator as an AI session with full knowledge of the instance tree (all child descriptions)
3. After ingestion, the orchestrator classifies each piece of data: which children should receive it?
4. Data can fan out to multiple targets — a Slack message mentioning two projects goes to both
5. Data that doesn't belong to any child stays in the global instance
6. Use `data.push` events on the bus to deliver data to children
7. Define the structured output format for routing decisions
8. Handle batching — process ingested data in batches, not one message at a time

## Tickets
- [029-centralize-ingestion](../tickets/029-centralize-ingestion.md)
- [030-orchestrator-ai-session](../tickets/030-orchestrator-ai-session.md)
- [031-data-classification-routing](../tickets/031-data-classification-routing.md)
- [032-multi-target-fanout](../tickets/032-multi-target-fanout.md)
- [033-global-fallback-storage](../tickets/033-global-fallback-storage.md)
- [034-data-push-delivery](../tickets/034-data-push-delivery.md)
- [035-routing-output-format](../tickets/035-routing-output-format.md)
- [036-batch-processing](../tickets/036-batch-processing.md)
