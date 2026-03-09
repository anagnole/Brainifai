import { MAX_SNIPPET_CHARS } from '../../shared/constants.js';
import { extractAnnotations } from '../topic-extractor.js';
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
  const annotations = extractAnnotations(text, allowlist);
  const semanticSet = new Set(annotations.topics);
  const allTopicNames = [...new Set([...labelTopics, ...annotations.topics])];
  const topics = allTopicNames.map((name) => ({
    name,
    tier: semanticSet.has(name) ? 'semantic' as const : 'ephemeral' as const,
  }));

  // Convert GitHub @mentions to person keys
  const ghMentions = extractGitHubMentions(text);
  const mentions = ghMentions.map((login) => `github:${login}`);

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
    mentions: mentions.length > 0 ? mentions : undefined,
    urls: annotations.urls.length > 0 ? annotations.urls : undefined,
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
  const annotations = extractAnnotations(comment.body ?? '', allowlist);
  const topics = annotations.topics.map((name) => ({ name, tier: 'semantic' as const }));

  // PR comment parent: derive PR source_id from the pull_request_url
  const prNumber = extractPrNumberFromUrl(comment.pull_request_url);
  const parentSourceId = prNumber
    ? `github:${repoFullName}:pr:${prNumber}`
    : undefined;

  const ghMentions = extractGitHubMentions(comment.body ?? '');
  const mentions = ghMentions.map((login) => `github:${login}`);

  return {
    activity: {
      source: 'github',
      source_id: `github:${repoFullName}:pr_comment:${comment.id}`,
      timestamp: comment.created_at,
      kind: 'pr_comment',
      snippet,
      url: comment.html_url,
      parent_source_id: parentSourceId,
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
    mentions: mentions.length > 0 ? mentions : undefined,
    urls: annotations.urls.length > 0 ? annotations.urls : undefined,
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
  const annotations = extractAnnotations(body, allowlist);
  const topics = annotations.topics.map((name) => ({ name, tier: 'semantic' as const }));

  const ghMentions = extractGitHubMentions(body);
  const mentions = ghMentions.map((login) => `github:${login}`);

  return {
    activity: {
      source: 'github',
      source_id: `github:${repoFullName}:pr_review:${review.id}`,
      timestamp: review.submitted_at,
      kind: 'pr_review',
      snippet,
      url: review.html_url,
      parent_source_id: `github:${repoFullName}:pr:${prNumber}`,
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
    mentions: mentions.length > 0 ? mentions : undefined,
    urls: annotations.urls.length > 0 ? annotations.urls : undefined,
  };
}

/** Extract GitHub @mentions (e.g. `@username`) from text. */
function extractGitHubMentions(text: string): string[] {
  const re = /(?:^|\s)@([a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38})/g;
  const mentions = new Set<string>();
  for (const match of text.matchAll(re)) {
    mentions.add(match[1]);
  }
  return [...mentions];
}

/** Extract PR number from a GitHub API pull_request_url. */
function extractPrNumberFromUrl(url?: string): number | null {
  if (!url) return null;
  const match = url.match(/\/pulls?\/(\d+)/);
  return match ? Number(match[1]) : null;
}
