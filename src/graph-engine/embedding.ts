// ─── Text embeddings (local) ────────────────────────────────────────────────
// Local embeddings via @xenova/transformers running a small sentence-embedding
// model in Node (ONNX runtime under the hood). No API key, no network after
// first model download. BGE-small-en-v1.5 at 384 dims is a strong quality/size
// tradeoff.

import { createHash } from 'node:crypto';
import { logger } from '../shared/logger.js';

// ─── Model config ───────────────────────────────────────────────────────────

export const DEFAULT_EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
export const DEFAULT_EMBED_DIM = 384;

// ─── Singleton embedder ─────────────────────────────────────────────────────

type Embedder = (text: string | string[], opts: { pooling: 'mean'; normalize: boolean }) =>
  Promise<{ data: Float32Array | number[] }>;

let embedder: Embedder | null = null;
let loadingPromise: Promise<Embedder> | null = null;
let modelName = DEFAULT_EMBED_MODEL;

/**
 * Lazily load the embedding model. First call downloads ~130MB (cached to
 * ~/.cache/huggingface/hub); subsequent calls are instant.
 */
async function getEmbedder(): Promise<Embedder> {
  if (embedder) return embedder;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    // Dynamic import — @xenova/transformers is a big dep; defer cost until first use.
    const { pipeline } = await import('@xenova/transformers');
    logger.info({ model: modelName }, 'Loading embedding model (first run may download ~130MB)');
    const t0 = Date.now();
    const pipe = await pipeline('feature-extraction', modelName);
    logger.info({ ms: Date.now() - t0 }, 'Embedding model ready');
    embedder = pipe as unknown as Embedder;
    return embedder;
  })();

  return loadingPromise;
}

/** For tests: override the default model. Resets the singleton. */
export function setEmbeddingModel(name: string): void {
  modelName = name;
  embedder = null;
  loadingPromise = null;
}

// ─── In-memory cache ────────────────────────────────────────────────────────
// Same text → same embedding. Cache keyed by sha256(text).slice(0, 16).

const CACHE_MAX = 5000;
const cache = new Map<string, number[]>();

function cacheKey(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function cacheGet(text: string): number[] | undefined {
  return cache.get(cacheKey(text));
}

function cacheSet(text: string, vec: number[]): void {
  if (cache.size >= CACHE_MAX) {
    // Drop oldest (first inserted) entry
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(cacheKey(text), vec);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Embed a single string. Returns a unit-normalized vector (so dot = cosine). */
export async function embed(text: string): Promise<number[]> {
  const hit = cacheGet(text);
  if (hit) return hit;

  const e = await getEmbedder();
  const output = await e(text, { pooling: 'mean', normalize: true });
  const vec = Array.from(output.data as Float32Array | number[]);
  cacheSet(text, vec);
  return vec;
}

/**
 * Embed a batch. Uses the underlying pipeline's batch inference when possible.
 * Returns one vector per input in order.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  // Short-circuit any cache hits.
  const results: (number[] | null)[] = texts.map((t) => cacheGet(t) ?? null);
  const missingIdx: number[] = [];
  for (let i = 0; i < texts.length; i++) if (!results[i]) missingIdx.push(i);
  if (missingIdx.length === 0) return results as number[][];

  const e = await getEmbedder();
  const missingTexts = missingIdx.map((i) => texts[i]!);
  const output = await e(missingTexts, { pooling: 'mean', normalize: true });

  // The pipeline returns a tensor with shape [n, dim]. `.data` is a flat
  // Float32Array; split by dim.
  const flat = Array.from(output.data as Float32Array | number[]);
  const dim = Math.floor(flat.length / missingTexts.length);
  for (let i = 0; i < missingIdx.length; i++) {
    const vec = flat.slice(i * dim, (i + 1) * dim);
    const origIdx = missingIdx[i]!;
    results[origIdx] = vec;
    cacheSet(texts[origIdx]!, vec);
  }
  return results as number[][];
}

// ─── Cosine similarity ──────────────────────────────────────────────────────
// BGE is unit-normalized (we passed normalize: true), so dot product = cosine.

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
