/** Raw JSONL line from a Claude Code session file. */
export interface SessionLine {
  type: string;
  sessionId?: string;
  slug?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  message?: {
    role?: string;
    type?: string;
    content?: string | ContentBlock[];
  };
}

export interface ContentBlock {
  type: string;
  text?: string;
}

/** Parsed + aggregated session data ready for normalization. */
export interface ParsedSession {
  sessionId: string;
  slug: string;
  projectDirName: string;
  projectName: string;
  cwd: string;
  gitBranch: string;
  firstTimestamp: string;
  lastTimestamp: string;
  userMessages: string[];
  assistantMessages: string[];
  filePath: string;
}

export interface SummarizeResult {
  summary: string;
  topics: string[];
}
