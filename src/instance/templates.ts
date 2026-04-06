import type { InstanceConfig, SourceSubscription } from './types.js';

export interface InstanceTemplate {
  type: string;
  description: string;
  sources: SourceSubscription[];
  contextFunctions: string[];
}

export const TEMPLATES: Record<string, InstanceTemplate> = {
  coding: {
    type: 'coding',
    description: 'Code-focused instance — GitNexus code intelligence (call chains, blast radius, symbol context) bridged with Brainifai KG decisions, sessions, and PR history',
    sources: [
      { source: 'github', enabled: true },
      { source: 'claude-code', enabled: true },
    ],
    contextFunctions: [
      'get_context_packet', 'search_entities', 'get_entity_summary',
      'get_recent_activity',
      'search_code', 'get_symbol_context', 'get_blast_radius', 'detect_code_changes',
      'get_pr_context', 'get_decision_log',
    ],
  },
  manager: {
    type: 'manager',
    description: 'People-focused instance — Slack conversations, calendar events, task tracking',
    sources: [
      { source: 'slack', enabled: true },
      { source: 'apple-calendar', enabled: true },
      { source: 'clickup', enabled: true },
    ],
    contextFunctions: [
      'get_context_packet', 'search_entities', 'get_entity_summary',
      'get_recent_activity',
      'get_people_context', 'get_meeting_summary',
    ],
  },
  ehr: {
    type: 'ehr',
    description: 'Clinical EHR instance with patient records, encounters, conditions, medications, labs, procedures, and providers. Designed for graph-based clinical QA evaluation.',
    sources: [],
    contextFunctions: [
      'search_patients',
      'get_patient_summary',
      'get_medications',
      'get_diagnoses',
      'get_labs',
      'get_temporal_relation',
      'find_cohort',
    ],
  },
  'project-manager': {
    type: 'project-manager',
    description: 'Project portfolio management — tracks health, cross-project dependencies, commit activity, Claude session history, and task progress across all repositories',
    sources: [],
    contextFunctions: [
      'search_projects', 'get_project_health', 'get_project_activity',
      'get_cross_project_impact', 'find_stale_projects',
      'get_dependency_graph', 'get_claude_session_history',
    ],
  },
  researcher: {
    type: 'researcher',
    description: 'Domain researcher instance — tracks entities, events, trends, and metrics in a configurable domain (AI, crypto, biotech, etc.) via LLM extraction from ingested activities',
    sources: [
      { source: 'twitter', enabled: true },
      { source: 'slack', enabled: true },
      { source: 'github', enabled: true },
    ],
    contextFunctions: [
      'get_context_packet', 'search_entities', 'get_entity_summary',
      'get_recent_activity',
      'get_landscape', 'get_entity_timeline', 'get_trending',
      'get_entity_network', 'search_events',
    ],
  },
  general: {
    type: 'general',
    description: 'Broad instance — subscribes to all available sources',
    sources: [
      { source: 'slack', enabled: true },
      { source: 'github', enabled: true },
      { source: 'clickup', enabled: true },
      { source: 'apple-calendar', enabled: true },
      { source: 'claude-code', enabled: true },
    ],
    contextFunctions: ['get_context_packet', 'search_entities', 'get_entity_summary', 'get_recent_activity'],
  },
};

export function getTemplate(type: string): InstanceTemplate | undefined {
  return TEMPLATES[type];
}

export function listTemplateNames(): string[] {
  return Object.keys(TEMPLATES);
}
