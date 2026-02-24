import { Octokit } from '@octokit/rest';
import { logger } from '../../shared/logger.js';
import type { GitHubPR, GitHubComment, GitHubReview } from './types.js';

const PAGE_SIZE = 100;

export function getGitHubClient(token: string): Octokit {
  return new Octokit({ auth: token });
}

export async function verifyAuth(client: Octokit): Promise<string> {
  const { data } = await client.rest.users.getAuthenticated();
  logger.info({ login: data.login }, 'GitHub auth verified');
  return data.login;
}

/**
 * Fetch PRs for a repo updated since `since` (ISO 8601).
 * Yields pages sorted by updated_at ascending.
 * Stops early once all items in a page are older than `since`.
 */
export async function* fetchPRs(
  client: Octokit,
  owner: string,
  repo: string,
  since?: string,
): AsyncGenerator<GitHubPR[]> {
  let page = 1;
  while (true) {
    const { data } = await client.rest.pulls.list({
      owner,
      repo,
      state: 'all',
      sort: 'updated',
      direction: 'asc',
      per_page: PAGE_SIZE,
      page,
    });

    if (data.length === 0) break;

    // Filter to only items updated after cursor
    const filtered = since
      ? data.filter((pr) => pr.updated_at > since)
      : data;

    if (filtered.length > 0) {
      yield filtered as unknown as GitHubPR[];
    }

    // If the last item is still older than cursor, keep paginating
    // If the page is smaller than PAGE_SIZE, we've reached the end
    if (data.length < PAGE_SIZE) break;
    page++;
  }
}

/**
 * Fetch all issue comments on PRs for a repo, created since `since`.
 * Uses the repo-level comments endpoint (covers all PR comments).
 */
export async function* fetchPRComments(
  client: Octokit,
  owner: string,
  repo: string,
  since?: string,
): AsyncGenerator<GitHubComment[]> {
  let page = 1;
  while (true) {
    const { data } = await client.rest.issues.listCommentsForRepo({
      owner,
      repo,
      sort: 'created',
      direction: 'asc',
      since,
      per_page: PAGE_SIZE,
      page,
    });

    if (data.length === 0) break;

    // Only yield comments on PRs (html_url contains /pull/)
    const prComments = data.filter((c) => c.html_url.includes('/pull/'));
    if (prComments.length > 0) {
      yield prComments as unknown as GitHubComment[];
    }

    if (data.length < PAGE_SIZE) break;
    page++;
  }
}

/**
 * Fetch all reviews for a single PR.
 */
export async function fetchPRReviews(
  client: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubReview[]> {
  const { data } = await client.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: PAGE_SIZE,
  });
  return data as unknown as GitHubReview[];
}
