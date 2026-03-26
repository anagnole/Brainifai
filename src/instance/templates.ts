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
    description: 'Code-focused instance — GitHub PRs, Claude Code sessions, code review context',
    sources: [
      { source: 'github', enabled: true },
      { source: 'claude-code', enabled: true },
    ],
    contextFunctions: [
      'get_context_packet', 'search_entities', 'get_entity_summary',
      'get_recent_activity',
      'get_pr_summary', 'get_decision_log',
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
