import { MAX_SNIPPET_CHARS } from '../../shared/constants.js';
import { extractTopics } from '../topic-extractor.js';
import type { NormalizedMessage } from '../../shared/types.js';
import type { ClickUpTask, ClickUpComment, ClickUpDoc, ClickUpTaskActivity } from './types.js';

function truncate(text: string): string {
  return text.length > MAX_SNIPPET_CHARS
    ? text.slice(0, MAX_SNIPPET_CHARS) + '…'
    : text;
}

function msToIso(ms: string): string {
  return new Date(Number(ms)).toISOString();
}

function listContainer(listId: string, listName: string) {
  return {
    source: 'clickup' as const,
    container_id: listId,
    name: listName,
    kind: 'list' as const,
  };
}

export function normalizeClickUpTask(
  task: ClickUpTask,
  listId: string,
  listName: string,
  allowlist: string[],
): NormalizedMessage | null {
  if (!task.creator) return null;

  const text = [task.name, task.description ?? ''].join('\n');
  const snippet = truncate(text);
  const personKey = `clickup:${task.creator.id}`;

  // Include task status as a topic
  const statusTopic = task.status?.status?.toLowerCase().replace(/\s+/g, '-');
  const textTopics = extractTopics(text, allowlist);
  const topics = [...new Set([...(statusTopic ? [statusTopic] : []), ...textTopics])].map((name) => ({ name }));

  return {
    activity: {
      source: 'clickup',
      source_id: `clickup:${listId}:task:${task.id}`,
      timestamp: msToIso(task.date_updated),
      kind: 'task',
      snippet,
      url: task.url,
    },
    person: {
      person_key: personKey,
      display_name: task.creator.username || task.creator.email,
      source: 'clickup',
      source_id: task.creator.id,
      avatar_url: task.creator.avatar ?? undefined,
    },
    container: listContainer(listId, listName),
    account: {
      source: 'clickup',
      account_id: task.creator.id,
      linked_person_key: personKey,
    },
    topics,
  };
}

export function normalizeClickUpComment(
  comment: ClickUpComment,
  listId: string,
  listName: string,
  allowlist: string[],
): NormalizedMessage | null {
  if (!comment.user) return null;
  if (comment.resolved) return null;
  if (!comment.comment_text?.trim()) return null;

  const snippet = truncate(comment.comment_text);
  const personKey = `clickup:${comment.user.id}`;
  const topics = extractTopics(comment.comment_text, allowlist).map((name) => ({ name }));

  return {
    activity: {
      source: 'clickup',
      source_id: `clickup:${listId}:comment:${comment.id}`,
      timestamp: msToIso(comment.date),
      kind: 'task_comment',
      snippet,
    },
    person: {
      person_key: personKey,
      display_name: comment.user.username || comment.user.email,
      source: 'clickup',
      source_id: comment.user.id,
      avatar_url: comment.user.avatar ?? undefined,
    },
    container: listContainer(listId, listName),
    account: {
      source: 'clickup',
      account_id: comment.user.id,
      linked_person_key: personKey,
    },
    topics,
  };
}

export function normalizeClickUpStatusChange(
  activityItem: ClickUpTaskActivity,
  task: ClickUpTask,
  listId: string,
  listName: string,
): NormalizedMessage | null {
  if (!activityItem.user) return null;

  const snippet = truncate(`${task.name}\nStatus: ${activityItem.before} → ${activityItem.after}`);
  const personKey = `clickup:${activityItem.user.id}`;

  return {
    activity: {
      source: 'clickup',
      source_id: `clickup:${listId}:activity:${activityItem.id}`,
      timestamp: msToIso(activityItem.date),
      kind: 'status_change',
      snippet,
      url: task.url,
    },
    person: {
      person_key: personKey,
      display_name: activityItem.user.username || activityItem.user.email,
      source: 'clickup',
      source_id: activityItem.user.id,
      avatar_url: activityItem.user.avatar ?? undefined,
    },
    container: listContainer(listId, listName),
    account: {
      source: 'clickup',
      account_id: activityItem.user.id,
      linked_person_key: personKey,
    },
    topics: [
      { name: activityItem.before.toLowerCase().replace(/\s+/g, '-') },
      { name: activityItem.after.toLowerCase().replace(/\s+/g, '-') },
    ],
  };
}

export function normalizeClickUpDoc(
  doc: ClickUpDoc,
  workspaceId: string,
  allowlist: string[],
): NormalizedMessage | null {
  if (!doc.creator) return null;

  const text = [doc.name, doc.content ?? ''].join('\n');
  const snippet = truncate(text);
  const personKey = `clickup:${doc.creator}`;
  const topics = extractTopics(text, allowlist).map((name) => ({ name }));

  return {
    activity: {
      source: 'clickup',
      source_id: `clickup:${workspaceId}:doc:${doc.id}`,
      timestamp: msToIso(doc.date_updated),
      kind: 'doc',
      snippet,
      url: doc.url,
    },
    person: {
      person_key: personKey,
      display_name: personKey, // Doc creator is just an ID; enriched later if needed
      source: 'clickup',
      source_id: String(doc.creator),
    },
    container: {
      source: 'clickup',
      container_id: workspaceId,
      name: 'ClickUp Workspace',
      kind: 'workspace',
    },
    account: {
      source: 'clickup',
      account_id: String(doc.creator),
      linked_person_key: personKey,
    },
    topics,
  };
}
