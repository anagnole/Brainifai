# Brainifai Roadmap

## Summary
Brainifai is a personal knowledge graph system that ingests data from work tools and provides contextual AI assistance. The current architecture uses a single global Kuzu database. This roadmap defines the evolution toward a federated, multi-instance architecture where each project gets its own Brainifai instance, coordinated by a global orchestrator through an event bus.

## Problem
As the global database grows, context gets noisier — AI sessions get lost in irrelevant data. Different projects have different needs, but everything is dumped into one graph. Non-core MCPs (ClickUp, fal.ai) are bundled into the repo, bloating the project's scope.

## Prior Art
- **Context Portal (ConPort)** — MCP-based project-specific knowledge graph. Similar concept but no multi-instance tree.
- **OpenContext** — Lightweight personal context store for coding tools. Simpler, no graph, no federation.
- **Federated Knowledge Graphs (Eclipse Tractus-X)** — Peer-to-peer dataspace as a virtual knowledge graph with delegated sub-queries. Closest to the event bus + routing concept.
- **Kuzu Memory Graph MCP** — Kuzu-based MCP memory server with dynamic database switching. Validates the multi-DB approach.
- No existing system combines graph-based knowledge + multi-instance tree + event bus + self-describing instances + per-project specialization.

## Phases Overview
1. **Clean Up & Extract** — Remove non-core MCPs, isolate Brainifai's actual core
2. **CLI & Instance Model** — Build the CLI, define instance types, self-describing instances
3. **Multi-Instance Kuzu** — Per-project Kuzu DBs, global registry of children
4. **Event Bus** — Inter-instance messaging for registration, updates, queries, responses
5. **Orchestrator** — Global AI session that ingests data and routes it to children
6. **Context Building** — Base + custom context functions, description auto-refinement
7. **Web App UI** — Unified interface for tree visualization, graph exploration, source configuration, and instance management

## Technical Stack
- **Database:** Kuzu (embedded, one instance per project)
- **Language:** TypeScript (ESM)
- **CLI:** TBD (likely Commander.js or similar)
- **Event Bus:** TBD (local IPC, file-based, or lightweight message queue)
- **Orchestrator:** AI session (Claude) with knowledge of the full instance tree
- **MCP:** Model Context Protocol SDK (stdio transport)

## Key Architectural Decisions
- Brainifai's core is ingestion, storage, context building, and memory. Everything else is out of scope.
- Only the global orchestrator ingests from external sources. Children never talk to sources directly.
- The orchestrator routes ingested data to children based on their descriptions. Data can fan out to multiple targets.
- Each instance has a description: set by user on init, auto-generated if not provided, updatable by AI sessions over time.
- Instance templates (coding, manager, general, etc.) bootstrap common configurations.
- The global instance's agent doubles as the tree coordinator/router.
