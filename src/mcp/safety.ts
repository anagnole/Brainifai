import {
  MAX_EVIDENCE_ITEMS,
  MAX_TOTAL_CHARS,
  MAX_SNIPPET_CHARS,
  QUERY_TIMEOUT_MS,
} from '../shared/constants.js';

/**
 * Wrap a promise with a timeout. Rejects if the promise doesn't resolve in time.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number = QUERY_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Query timed out after ${ms}ms`)),
      ms,
    );
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Truncate a single snippet to max chars.
 */
export function truncateSnippet(text: string): string {
  if (text.length <= MAX_SNIPPET_CHARS) return text;
  return text.slice(0, MAX_SNIPPET_CHARS) + '…';
}

/**
 * Cap an array of evidence items by count and total character budget.
 */
export function truncateEvidence<T extends { snippet?: string }>(
  items: T[],
  maxItems: number = MAX_EVIDENCE_ITEMS,
  maxChars: number = MAX_TOTAL_CHARS,
): T[] {
  const capped: T[] = [];
  let totalChars = 0;

  for (const item of items.slice(0, maxItems)) {
    const snippet = item.snippet ?? '';
    if (totalChars + snippet.length > maxChars) break;
    totalChars += snippet.length;
    capped.push(item);
  }

  return capped;
}
