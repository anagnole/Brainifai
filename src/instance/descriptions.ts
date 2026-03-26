import type { SourceSubscription } from './types.js';

/** Generate a human-readable description from instance metadata */
export function generateDescription(
  name: string,
  type: string,
  sources: SourceSubscription[],
): string {
  const enabledSources = sources
    .filter(s => s.enabled)
    .map(s => s.source)
    .join(', ');

  const typeLabel = type === 'coding' ? 'Coding project'
    : type === 'manager' ? 'Management'
    : type === 'general' ? 'General-purpose'
    : type === 'project-manager' ? 'Project Manager'
    : `Custom (${type})`;

  return `${typeLabel} instance for ${name}, subscribed to ${enabledSources || 'no sources'}.`;
}
