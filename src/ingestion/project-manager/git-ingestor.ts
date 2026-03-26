/**
 * Git ingestor — parses git log for commits and branches per repo.
 */

import { execSync } from 'node:child_process';

export interface GitCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  files_changed_count: number;
  insertions: number;
  deletions: number;
}

export interface GitBranch {
  branch_key: string;
  project_slug: string;
  name: string;
  is_default: boolean;
  last_commit_date: string;
  ahead: number;
  behind: number;
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 15000,
    }).toString().trim();
  } catch {
    return '';
  }
}

/** Parse recent commits from git log. */
export function ingestCommits(repoPath: string, projectSlug: string, maxCommits = 200): GitCommit[] {
  // Format: sha|author|date|subject
  const logOut = run(
    `git log -${maxCommits} --format="%H|%an|%aI|%s" --no-merges`,
    repoPath,
  );
  if (!logOut) return [];

  const commits: GitCommit[] = [];
  for (const line of logOut.split('\n')) {
    if (!line.trim()) continue;
    const [sha, author, dateRaw, ...subjectParts] = line.split('|');
    if (!sha || sha.length < 7) continue;

    const message = subjectParts.join('|').trim();
    const date = dateRaw?.split('T')[0] ?? '';

    // Get diff stats for this commit
    const statsOut = run(`git show --stat --format="" ${sha}`, repoPath);
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    const summaryLine = statsOut.split('\n').find((l) => l.includes('changed'));
    if (summaryLine) {
      const fMatch = summaryLine.match(/(\d+) file/);
      const iMatch = summaryLine.match(/(\d+) insertion/);
      const dMatch = summaryLine.match(/(\d+) deletion/);
      if (fMatch) filesChanged = parseInt(fMatch[1], 10);
      if (iMatch) insertions = parseInt(iMatch[1], 10);
      if (dMatch) deletions = parseInt(dMatch[1], 10);
    }

    commits.push({ sha, message, author: author?.trim() ?? '', date, files_changed_count: filesChanged, insertions, deletions });
  }
  return commits;
}

/** Return branch list with tracking info. */
export function ingestBranches(repoPath: string, projectSlug: string): GitBranch[] {
  // Use plain `git branch -a` to avoid shell escaping issues with --format=%(...)
  const branchOut = run('git branch -a', repoPath);
  if (!branchOut) return [];

  // Detect default branch
  let defaultBranch = run('git symbolic-ref refs/remotes/origin/HEAD --short', repoPath)
    .replace('origin/', '').trim();
  if (!defaultBranch) defaultBranch = 'main';

  const localBranches = branchOut.split('\n')
    // Strip leading *, +, spaces (branch decorators from `git branch -a`)
    .map((b) => b.replace(/^[*+\s]+/, '').trim())
    .filter((b) => b && !b.startsWith('remotes/') && !b.includes('HEAD'));

  const branches: GitBranch[] = [];
  for (const name of localBranches) {
    const lastCommitDate = run(`git log -1 --format=%aI ${name}`, repoPath).split('T')[0];

    let ahead = 0;
    let behind = 0;
    const trackingOut = run(`git rev-list --left-right --count origin/${defaultBranch}...${name}`, repoPath);
    if (trackingOut) {
      const parts = trackingOut.split('\t');
      behind = parseInt(parts[0] ?? '0', 10) || 0;
      ahead = parseInt(parts[1] ?? '0', 10) || 0;
    }

    branches.push({
      branch_key: `${projectSlug}:${name}`,
      project_slug: projectSlug,
      name,
      is_default: name === defaultBranch,
      last_commit_date: lastCommitDate,
      ahead,
      behind,
    });
  }
  return branches;
}
