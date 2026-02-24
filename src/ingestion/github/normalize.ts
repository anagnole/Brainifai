import { MAX_SNIPPET_CHARS } from '../../shared/constants.js';
import { extractTopics } from '../topic-extractor.js';
import type { NormalizedMessage } from '../../shared/types.js';
import type { GitHubPR, GitHubComment, GitHubReview } from './types.js';

function truncate(text: string): string {
  return text.length > MAX_SNIPPET_CHARS
    ? text.slice(0, MAX_SNIPPET_CHARS) + '…'
    : text;
}

function repoContainer(repoFullName: string) {
  return {
    source: 'github' as const,
    container_id: repoFullName,
    name: repoFullName,
    kind: 'repository' as const,
  };
}

export function normalizeGitHubPR(
  pr: GitHubPR,
  repoFullName: string,
  allowlist: string[],
): NormalizedMessage | null {
  if (!pr.user) return null;

  const text = [pr.title, pr.body ?? ''].join('\n');
  const snippet = truncate(text);
  const personKey = `github:${pr.user.login}`;

  // Extract topics from body + labels
  const labelTopics = pr.labels.map((l) => l.name.toLowerCase());
  const textTopics = extractTopics(text, allowlist);
  const topics = [...new Set([...labelTopics, ...textTopics])].map((name) => ({ name }));

  return {
    activity: {
      source: 'github',
      source_id: `github:${repoFullName}:pr:${pr.number}`,
      timestamp: pr.updated_at,
      kind: 'pull_request',
      snippet,
      url: pr.html_url,
    },
    person: {
      person_key: personKey,
      display_name: pr.user.login,
      source: 'github',
      source_id: pr.user.login,
      avatar_url: pr.user.avatar_url,
    },
    container: repoContainer(repoFullName),
    account: {
      source: 'github',
      account_id: pr.user.login,
      linked_person_key: personKey,
    },
    topics,
  };
}

export function normalizeGitHubComment(
  comment: GitHubComment,
  repoFullName: string,
  allowlist: string[],
): NormalizedMessage | null {
  if (!comment.user) return null;

  const snippet = truncate(comment.body ?? '');
  const personKey = `github:${comment.user.login}`;
  const topics = extractTopics(comment.body ?? '', allowlist).map((name) => ({ name }));

  return {
    activity: {
      source: 'github',
      source_id: `github:${repoFullName}:pr_comment:${comment.id}`,
      timestamp: comment.created_at,
      kind: 'pr_comment',
      snippet,
      url: comment.html_url,
    },
    person: {
      person_key: personKey,
      display_name: comment.user.login,
      source: 'github',
      source_id: comment.user.login,
      avatar_url: comment.user.avatar_url,
    },
    container: repoContainer(repoFullName),
    account: {
      source: 'github',
      account_id: comment.user.login,
      linked_person_key: personKey,
    },
    topics,
  };
}

export function normalizeGitHubReview(
  review: GitHubReview,
  repoFullName: string,
  prNumber: number,
  allowlist: string[],
): NormalizedMessage | null {
  if (!review.user) return null;
  if (!review.submitted_at) return null;
  // Skip empty COMMENTED reviews — low signal noise
  if (review.state === 'COMMENTED' && !review.body) return null;

  const body = review.body ?? '';
  const text = `[${review.state}] ${body}`.trim();
  const snippet = truncate(text);
  const personKey = `github:${review.user.login}`;
  const topics = extractTopics(body, allowlist).map((name) => ({ name }));

  return {
    activity: {
      source: 'github',
      source_id: `github:${repoFullName}:pr_review:${review.id}`,
      timestamp: review.submitted_at,
      kind: 'pr_review',
      snippet,
      url: review.html_url,
    },
    person: {
      person_key: personKey,
      display_name: review.user.login,
      source: 'github',
      source_id: review.user.login,
      avatar_url: review.user.avatar_url,
    },
    container: repoContainer(repoFullName),
    account: {
      source: 'github',
      account_id: review.user.login,
      linked_person_key: personKey,
    },
    topics,
  };
}
