# Graph Management — Split into Engine + Per-Type Docs

This doc has been split. See:

- **`graph-engine.md`** — the type-agnostic machinery (write path, resolver, extraction worker, maintenance passes, single-writer lock, aging). Reusable across all instance types.
- **`general-instance-graph.md`** — concrete configuration for the always-on general instance (schema spec, extract prompts, resolver weights, maintenance policies, retrieval functions).

Future per-type graph docs will live alongside: `ehr-instance-graph.md`, `researcher-instance-graph.md`, `coding-instance-graph.md`, `project-manager-instance-graph.md`, `manager-instance-graph.md`.

The split reflects a core architectural decision: graph building, resolving, maintaining, and reading are type-agnostic primitives. Each type plugs in a `SchemaSpec` + prompts + config; the engine handles the rest.
