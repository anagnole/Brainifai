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
    contextFunctions: ['get_context_packet', 'search_entities', 'get_entity_summary', 'get_recent_activity'],
  },
  manager: {
    type: 'manager',
    description: 'People-focused instance — Slack conversations, calendar events, task tracking',
    sources: [
      { source: 'slack', enabled: true },
      { source: 'apple-calendar', enabled: true },
      { source: 'clickup', enabled: true },
    ],
    contextFunctions: ['get_context_packet', 'search_entities', 'get_entity_summary', 'get_recent_activity'],
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
    contextFunctions: ['get_context_packet', 'search_entities', 'get_entity_summary', 'get_recent_activity', 'ingest_memory'],
  },
};

export function getTemplate(type: string): InstanceTemplate | undefined {
  return TEMPLATES[type];
}

export function listTemplateNames(): string[] {
  return Object.keys(TEMPLATES);
}
