# Phase 6: Context Building

## Goal
Define the context building system — base functions that every instance gets, plus custom functions per instance type. Instance descriptions auto-refine over time.

## Dependencies
- Phase 5 (orchestrator is routing data to children)

## Steps
1. Define base context functions that every instance ships with (entity search, recent activity, context packet, memory ingestion)
2. Define custom context functions per instance template:
   - Coding project: code-focused context, PR summaries, technical decisions
   - Manager: people-focused context, meeting summaries, task status
   - General: broad context, cross-topic search
3. Allow instances to add or remove context functions beyond their template defaults
4. Instance descriptions auto-refine: as the instance accumulates data, the AI session can update the description to better reflect its contents
5. Context queries can traverse the tree — a child can ask the parent for broader context, and the parent can delegate to other children based on their descriptions
6. Update the MCP server to work with the new multi-instance model — connect to the relevant instance(s) for the current session

## Tickets
- [037-base-context-functions](../tickets/037-base-context-functions.md)
- [038-template-custom-functions](../tickets/038-template-custom-functions.md)
- [039-configurable-context-functions](../tickets/039-configurable-context-functions.md)
- [040-description-auto-refinement](../tickets/040-description-auto-refinement.md)
- [041-tree-traversal-queries](../tickets/041-tree-traversal-queries.md)
- [042-mcp-multi-instance-support](../tickets/042-mcp-multi-instance-support.md)
