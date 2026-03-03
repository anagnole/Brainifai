const HASHTAG_RE = /(?:^|\s)#(\w{2,})/g;
const SLACK_MENTION_RE = /<@(\w+)>/g;
const URL_RE = /https?:\/\/[^\s<>)"']+/g;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface Annotations {
  topics: string[];
  mentionedUserIds: string[];
  urls: string[];
}

/**
 * Extract annotations from message text:
 * - Topics from hashtags and allowlist keyword matching (word-boundary safe).
 * - @mention user IDs (Slack format `<@U12345>`).
 * - URLs.
 *
 * All topics returned as lowercase, deduplicated.
 */
export function extractAnnotations(text: string, allowlist: string[]): Annotations {
  const topics = new Set<string>();
  const mentionedUserIds: string[] = [];
  const urls: string[] = [];

  // Extract hashtags
  for (const match of text.matchAll(HASHTAG_RE)) {
    topics.add(match[1].toLowerCase());
  }

  // Match against allowlist using word boundaries (case-insensitive)
  for (const keyword of allowlist) {
    const pattern = new RegExp('\\b' + escapeRegex(keyword) + '\\b', 'i');
    if (pattern.test(text)) {
      topics.add(keyword.toLowerCase());
    }
  }

  // Extract @mentions (Slack format)
  for (const match of text.matchAll(SLACK_MENTION_RE)) {
    mentionedUserIds.push(match[1]);
  }

  // Extract URLs
  for (const match of text.matchAll(URL_RE)) {
    urls.push(match[0]);
  }

  return {
    topics: [...topics],
    mentionedUserIds: [...new Set(mentionedUserIds)],
    urls: [...new Set(urls)],
  };
}

/**
 * @deprecated Use `extractAnnotations` instead. Kept for backward compatibility.
 */
export function extractTopics(text: string, allowlist: string[]): string[] {
  return extractAnnotations(text, allowlist).topics;
}
