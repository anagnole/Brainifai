// ─── SchemaSpec for the `general` instance ──────────────────────────────────
// The always-on brain-like knowledge graph. Models Memory atoms, people /
// projects / concepts as entities, and a single weighted ASSOCIATED edge
// kind. Episodes group a session's atoms; aging tiers surface recent content.

import type { SchemaSpec } from '../../graph-engine/types.js';
import { generalExtractPrompt } from './extract-prompt.js';

export const generalSpec: SchemaSpec = {
  typeName: 'general',

  // Table names default to Atom/Entity/Episode; leave unset.
  atomKinds: ['memory'],
  entityTypes: ['person', 'project', 'tool', 'place', 'concept', 'category', 'topic', 'other'],

  associationKinds: [
    { name: 'ASSOCIATED', weighted: true },  // generic co-occurrence
    { name: 'IS_A', weighted: false },       // ontology: Brainifai IS_A project
  ],

  occurrenceKinds: [
    { name: 'MENTIONS', hasProminence: true },
  ],

  episodesEnabled: true,
  agingEnabled: true,
  reconsolidationEnabled: true,
  retrievalCoActivationEnabled: true,
  writeMode: 'text',

  // Local embeddings via @xenova/transformers (BGE-small-en-v1.5 at 384 dims).
  // See docs/design/graph-engine.md §8. Used to:
  //   - boost cue resolution (paraphrase queries)
  //   - extend resolver candidate pool (semantic entity matches)
  //   - seed maintenance passes (alias confirm pre-filter, dedupe)
  embeddingsEnabled: true,
  embeddingDim: 384,

  extractPrompt: generalExtractPrompt,

  resolverConfig: {
    weights: {
      name_similarity:    0.35,
      recency:            0.15,
      context_overlap:    0.30,
      cwd_instance_match: 0.10,
      type_match:         0.10,
    },
    acceptThreshold:    0.75,
    uncertainThreshold: 0.50,
  },

  // Phase 9 — maintenance policies will be added when the maintenance runner lands.
  maintenancePolicies: [],
};
