# Phase 7: Web App UI

## Goal
Build a unified web interface for managing and exploring the Brainifai tree. Visualize the instance tree, explore individual graphs, configure ingestion sources, and manage instances — all from one place.

## Dependencies
- Phase 6 (context building and multi-instance model are working)

## Steps
1. Design the UI architecture — consolidate or replace the existing Next.js admin dashboard and Sigma.js visualization into one unified app
2. Tree visualization — interactive view of the full instance tree (global → children), showing instance types, descriptions, status
3. Graph explorer — drill into any instance and explore its knowledge graph visually (nodes, edges, relationships)
4. Instance management — create, configure, and delete instances from the UI (same as CLI but visual)
5. Source configuration — configure ingestion sources (credentials, channels, repos, calendars) per instance or globally
6. Ingestion monitoring — trigger ingestion, view live logs, see last sync timestamps and status per source
7. Routing visibility — see how the orchestrator is routing data to children, what went where
8. Instance description editor — view and edit instance descriptions, see auto-generated vs user-provided

## Tickets
- [043-ui-architecture-design](../tickets/043-ui-architecture-design.md)
- [044-tree-visualization](../tickets/044-tree-visualization.md)
- [045-graph-explorer](../tickets/045-graph-explorer.md)
- [046-instance-management-ui](../tickets/046-instance-management-ui.md)
- [047-source-configuration-ui](../tickets/047-source-configuration-ui.md)
- [048-ingestion-monitoring](../tickets/048-ingestion-monitoring.md)
- [049-routing-visibility](../tickets/049-routing-visibility.md)
- [050-description-editor](../tickets/050-description-editor.md)
