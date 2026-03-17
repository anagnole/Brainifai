# Phase 1: Clean Up & Extract

## Goal
Isolate Brainifai's core by removing non-core MCPs and understanding which existing concepts (ingestion, context building, memory) work and should carry forward into the new architecture.

## Steps
1. Extract `mcp-clickup` into its own repository
2. Extract `mcp-fal` into its own repository
3. Identify any other non-core pieces in the codebase and extract or remove them
4. Conceptual audit of the ingestion pipeline — understand what works, what doesn't
5. Conceptual audit of context building (`get_context_packet`, entity search) — is the output useful?
6. Conceptual audit of memory (`ingest_memory`) — how well does the remember flow work?
7. Conceptual audit of the MERGE/upsert process — is deduplication solid?
8. Document findings and what to carry forward vs. rebuild

## Tickets
- [001-extract-clickup-mcp](../tickets/001-extract-clickup-mcp.md)
- [002-extract-fal-mcp](../tickets/002-extract-fal-mcp.md)
- [003-identify-non-core-pieces](../tickets/003-identify-non-core-pieces.md)
- [004-audit-ingestion](../tickets/004-audit-ingestion.md)
- [005-audit-context-building](../tickets/005-audit-context-building.md)
- [006-audit-memory](../tickets/006-audit-memory.md)
- [007-audit-merge-upsert](../tickets/007-audit-merge-upsert.md)
- [008-document-audit-findings](../tickets/008-document-audit-findings.md)
