---
name: remember
description: Save knowledge from the current conversation (decisions, insights, bug fixes) into the Brainifai knowledge graph for long-term recall.
disable-model-invocation: true
argument-hint: [optional context about what to remember]
---

# /remember — Save Knowledge to Brainifai

When invoked, capture the current conversation's key knowledge into the Brainifai knowledge graph using the `ingest_memory` MCP tool.

## Steps

1. **Review the conversation** — scan the recent exchange for valuable knowledge: decisions made, bugs fixed, insights discovered, architectural choices, or user preferences. If `$ARGUMENTS` is provided, focus on that specific topic.

2. **Write a concise summary** — 1-3 paragraphs capturing the essence of what was learned. Focus on the "what" and "why", not the step-by-step process.

3. **Extract topics** — identify 3-8 lowercase topic keywords (technologies, concepts, project areas). Examples: `typescript`, `authentication`, `performance`, `kuzu`, `ingestion`.

4. **Determine the kind**:
   - `decision` — an architectural or design choice was made
   - `insight` — a new understanding or discovery
   - `bug_fix` — a bug was identified and resolved
   - `preference` — a user workflow or tool preference
   - `session_summary` — general session recap

5. **Call `ingest_memory`** with the summary as `snippet`, the extracted `topics`, the `kind`, and optionally the `project` name.

6. **Confirm** — tell the user what was saved and the topics it was filed under.
