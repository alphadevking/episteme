import { embedMany } from 'ai';
import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { EMBED_CONFIG } from '../config';

export interface SparseVector {
  indices: number[];
  values: number[];
}

const embeddingModel = new ModelRouterEmbeddingModel('mistral/mistral-embed');

/**
 * Generate dense embeddings via Mastra's model router → mistral/mistral-embed.
 * Same routing mechanism used by the episteme-chat-agent for LLM calls.
 * Outputs 1024-dimension vectors. Batches to stay within API limits.
 */
/** Run tasks with a max concurrency cap — avoids slamming the Mistral rate limit. */
async function withConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const BATCH_SIZE = EMBED_CONFIG.batchSize;

  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }

  // Max 3 concurrent Mistral embed calls — fast enough, under rate-limit ceiling.
  const results = await withConcurrency(
    batches.map((batch) => () => embedMany({ model: embeddingModel, values: batch, maxRetries: 3 })),
    3,
  );

  return results.flatMap((r) => r.embeddings);
}

/**
 * BM25-style sparse vector for hybrid search.
 * Uses TF (term frequency within document) with a hash-based term index.
 * Scores are positive floats compatible with Pinecone dotproduct hybrid queries.
 */
export function buildSparseVector(text: string): SparseVector {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { indices: [], values: [] };

  const termFreq = new Map<string, number>();
  for (const token of tokens) {
    termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
  }

  const indices: number[] = [];
  const values: number[] = [];

  for (const [term, freq] of termFreq.entries()) {
    const tf = freq / tokens.length;
    indices.push(hashTerm(term));
    values.push(tf);
  }

  return { indices, values };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Deterministic hash of a term to a sparse index (0–999,999).
 * djb2 variant — lower collision rate than simple modulo hash.
 */
function hashTerm(term: string): number {
  let hash = 5381;
  for (let i = 0; i < term.length; i++) {
    hash = ((hash << 5) + hash) ^ term.charCodeAt(i);
    hash = hash & 0x7fffffff;
  }
  return hash % 1_000_000;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her',
  'was', 'one', 'our', 'had', 'his', 'they', 'will', 'with', 'have',
  'this', 'from', 'that', 'been', 'each', 'she', 'which', 'their',
  'more', 'when', 'may', 'also', 'any', 'its', 'into', 'than', 'then',
  'has', 'who', 'would', 'should', 'could', 'about', 'such', 'these',
]);
