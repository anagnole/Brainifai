---
name: recall
description: Search the Brainifai knowledge graph for memories related to a cue. Supports paraphrases — "the book I was reading" can find memories that never mention that phrase.
disable-model-invocation: true
argument-hint: <search cue>
---

# /recall — Search the Brainifai Graph

Search the knowledge graph using the `associate` MCP tool (spreading activation with embedding-based cue resolution).

## Steps

1. **Get the cue** from `$ARGUMENTS`. If empty, ask the user what they want to find.

2. **Call `associate`** with the cue. Use a `limit` of 10 unless the user asks for more.

3. **Present the results** — show each hit with:
   - A short label (kind + first 80 chars of content)
   - Date
   - Score (two decimal places)

   Group by date bucket if there are more than 5 results: today / this week / this month / older.

4. **If the top result has a clear connection to the cue**, quote it verbatim. Let the user decide if it's what they meant.

5. **Offer follow-ups** — if the top hit mentions an entity that seems relevant (person, project, concept), suggest the user recall more via `/recall <entity>`.

## Tips

- Paraphrases work: `/recall "the database we picked"` can find Kuzu-related memories.
- Short cues work: `/recall 5k` finds all 5k-related atoms via partial-name matching.
- For time-bounded recall, prefer `recall_episode` instead of `associate`.
