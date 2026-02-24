const HASHTAG_RE = /(?:^|\s)#(\w{2,})/g;

/**
 * Extract topics from message text.
 * Sources: hashtags (#deploy) and allowlist keyword matching.
 * All topics returned as lowercase, deduplicated.
 */
export function extractTopics(text: string, allowlist: string[]): string[] {
  const topics = new Set<string>();

  // Extract hashtags
  for (const match of text.matchAll(HASHTAG_RE)) {
    topics.add(match[1].toLowerCase());
  }

  // Match against allowlist (case-insensitive)
  const lowerText = text.toLowerCase();
  for (const keyword of allowlist) {
    if (lowerText.includes(keyword)) {
      topics.add(keyword);
    }
  }

  return [...topics];
}
