export interface GitHubUser {
  login: string;
  avatar_url: string;
}

export interface GitHubLabel {
  name: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: GitHubUser;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  html_url: string;
  labels: GitHubLabel[];
}

/** issue_comment on a PR (general comments, not line-level review comments) */
export interface GitHubComment {
  id: number;
  body: string;
  user: GitHubUser;
  created_at: string;
  html_url: string;
  pull_request_url?: string; // GitHub API returns this for PR issue comments
}

export interface GitHubReview {
  id: number;
  body: string | null;
  state: string; // "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"
  user: GitHubUser;
  submitted_at: string | null;
  html_url: string;
}
