import { MAX_SNIPPET_CHARS } from '../../shared/constants.js';
import { stripAnsi } from '../../shared/sanitize.js';
import { extractAnnotations } from '../topic-extractor.js';
import type { NormalizedMessage, Topic } from '../../shared/types.js';
import type { ParsedSession, SummarizeResult } from './types.js';

function truncate(text: string): string {
  return text.length > MAX_SNIPPET_CHARS
    ? text.slice(0, MAX_SNIPPET_CHARS) + '…'
    : text;
}

export function normalizeSession(
  session: ParsedSession,
  result: SummarizeResult,
  userName: string,
  allowlist: string[],
): NormalizedMessage {
  const cleanSummary = stripAnsi(result.summary);
  const snippet = truncate(cleanSummary);
  const personKey = `local:${userName}`;
  const sourceId = `claude-code:${session.projectDirName}:${session.sessionId}`;

  // Merge LLM topics + allowlist matches from the cleaned summary text
  const annotations = extractAnnotations(cleanSummary, allowlist);

  // Semantic topics (from LLM + allowlist)
  const semanticTopics = new Set([
    ...result.topics,
    ...annotations.topics,
  ]);

  // Ephemeral topics (project name, branch names used as labels)
  const ephemeralNames = new Set<string>();
  ephemeralNames.add(session.projectName.toLowerCase());
  if (session.gitBranch) {
    ephemeralNames.add(session.gitBranch.toLowerCase());
  }

  const topics: Topic[] = [
    ...[...semanticTopics].map((name) => ({ name, tier: 'semantic' as const })),
    ...[...ephemeralNames]
      .filter((name) => !semanticTopics.has(name))
      .map((name) => ({ name, tier: 'ephemeral' as const })),
  ];

  return {
    activity: {
      source: 'claude-code',
      source_id: sourceId,
      timestamp: session.lastTimestamp,
      kind: 'session_summary',
      snippet,
      message_count: session.userMessages.length + session.assistantMessages.length,
      created_at: session.firstTimestamp,
      updated_at: session.lastTimestamp,
      valid_from: session.firstTimestamp,
    },
    person: {
      person_key: personKey,
      display_name: userName,
      source: 'local',
      source_id: userName,
    },
    container: {
      source: 'claude-code',
      container_id: session.projectDirName,
      name: session.projectName,
      kind: 'project',
    },
    account: {
      source: 'local',
      account_id: `local:${userName}`,
      linked_person_key: personKey,
    },
    topics,
    urls: annotations.urls.length > 0 ? annotations.urls : undefined,
  };
}
