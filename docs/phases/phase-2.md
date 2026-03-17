# Phase 2: CLI & Instance Model

## Goal
Build the `brainifai` CLI and define the instance model — instance types, self-describing instances, and the init flow for both global and project-level instances.

## Dependencies
- Phase 1 (core is isolated and understood)

## Steps
1. Design the instance data model — what properties does an instance have (name, type, description, parent, sources, etc.)
2. Define instance templates (coding project, manager, general, etc.) with sensible defaults
3. Build the `brainifai` CLI tool
4. Implement `brainifai init` for global instance creation at `~/.brainifai/`
5. Implement `brainifai init` inside a project for child instance creation at `<project>/.brainifai/`
6. Auto-generate instance description based on type and config if user doesn't provide one
7. Allow AI sessions to update instance descriptions over time
8. Instance configuration storage — where and how each instance stores its config

## Tickets
- [009-design-instance-model](../tickets/009-design-instance-model.md)
- [010-define-instance-templates](../tickets/010-define-instance-templates.md)
- [011-build-cli](../tickets/011-build-cli.md)
- [012-global-instance-init](../tickets/012-global-instance-init.md)
- [013-project-instance-init](../tickets/013-project-instance-init.md)
- [014-auto-generate-descriptions](../tickets/014-auto-generate-descriptions.md)
- [015-session-description-updates](../tickets/015-session-description-updates.md)
- [016-instance-config-storage](../tickets/016-instance-config-storage.md)
