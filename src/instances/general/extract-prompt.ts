// ─── Extract prompt for the general instance ───────────────────────────────
// Used by the engine's worker to extract named entities from each Memory's
// content. Keep the output schema stable — the worker's extractJsonOr parses
// a plain array of {name, type, prominence}.

export const GENERAL_ENTITY_TYPES = [
  'person',
  'project',
  'tool',
  'place',
  'concept',
  'category',
  'topic',
  'other',
] as const;

export function generalExtractPrompt(content: string): string {
  return `Extract named entities from this memory.

Memory: """${content}"""

Return a JSON array — no markdown, no commentary, no prose before or after:
[{"name": "...", "type": "<one of ${GENERAL_ENTITY_TYPES.join('|')}>", "prominence": 0..1}]

Rules:
- Only include named, specific things. Skip generic terms ("thing", "person", "idea", "project" without a name).
- Resolve clear pronouns to names when unambiguous; otherwise drop them.
- prominence = how central the entity is to the memory. 0.9 for the subject/main focus, 0.3 for a passing mention.
- If nothing is extractable, return an empty array: []
- Return ONLY the JSON array.`;
}
