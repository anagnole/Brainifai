import { MAX_SNIPPET_CHARS } from '../../shared/constants.js';
import { extractAnnotations } from '../topic-extractor.js';
import type { NormalizedMessage } from '../../shared/types.js';
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
  const snippet = truncate(result.summary);
  const personKey = `local:${userName}`;
  const sourceId = `claude-code:${session.projectDirName}:${session.sessionId}`;

  // Merge LLM topics + allowlist matches from the summary text
  const annotations = extractAnnotations(result.summary, allowlist);
  const allTopics = new Set([
    ...result.topics,
    ...annotations.topics,
    session.projectName.toLowerCase(),
  ]);
  if (session.gitBranch) {
    allTopics.add(session.gitBranch.toLowerCase());
  }

  const topics = [...allTopics].map((name) => ({ name }));

  return {
    activity: {
      source: 'claude-code',
      source_id: sourceId,
      timestamp: session.lastTimestamp,
      kind: 'session_summary',
      snippet,
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
