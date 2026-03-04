interface CacheEntry {
  result: string;
  timestamp: number;
}

const TTL_MS = 60_000; // 1 minute
const MAX_SIZE = 50;
const cache = new Map<string, CacheEntry>();

export function getCached(key: string): string | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

export function setCache(key: string, result: string): void {
  if (cache.size >= MAX_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { result, timestamp: Date.now() });
}
