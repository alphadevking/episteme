// episteme-core/src/mastra/tools/rerank.ts
/**
 * Cross-encoder reranking of retrieved chunks.
 *
 * WHY THIS EXISTS (measured, `pnpm eval:retrieval --scores`, 2026-08-02):
 * embedding similarity cannot express relevance for this corpus. In-domain
 * queries scored 0.694–0.808 and out-of-domain probes 0.611–0.744 — overlapping
 * ranges, so no threshold separates them. The two worst offenders were
 * "weather in Benin City" and "how do I apply to Harvard University": both share
 * heavy vocabulary with a Uniben corpus while answering nothing in it, which is
 * exactly the case a bi-encoder gets wrong and a cross-encoder gets right.
 *
 * A bi-encoder embeds query and document independently and compares vectors, so
 * it measures topical overlap. A cross-encoder reads the pair together and
 * scores "does this passage answer THIS question" — the distinction the score
 * data says we need.
 *
 * FAIL-SOFT BY CONSTRUCTION: reranking is an extra network call in the request
 * path of every answer. If it errors, times out, or returns something
 * unexpected, retrieval falls back to embedding order rather than failing the
 * turn. A relevance refinement must never be able to take chat down — that is
 * the same lesson as the storage outage, applied before the incident.
 */

/** Minimal shape this module needs from a retrieved chunk. */
export interface RerankableChunk {
  /** Text the cross-encoder scores the query against. */
  text: string;
}

/** A rerank provider's response, narrowed to what we consume. */
export interface RerankScore {
  /** Index into the ORIGINAL documents array. */
  index: number;
  score: number;
}

/**
 * Reorder chunks by rerank score and drop those below the floor.
 *
 * Pure: the provider call is injected, so every decision rule here is unit
 * tested without a network or an API key.
 *
 * Defensive about provider output because a malformed response must degrade to
 * "keep the original order", never to "drop everything":
 *   - an index outside the input array is ignored;
 *   - a duplicated index is honoured once;
 *   - a chunk the provider omitted entirely is dropped only if the provider
 *     returned SOMETHING, since a partial response is still a judgement.
 */
export function applyRerankScores<T>(
  chunks: T[],
  scores: RerankScore[],
  minScore: number,
): { kept: T[]; keptScores: number[]; droppedByFloor: number } {
  if (scores.length === 0) {
    // No judgement at all — keep the input untouched rather than invent one.
    return { kept: chunks, keptScores: [], droppedByFloor: 0 };
  }

  const seen = new Set<number>();
  const ordered: Array<{ chunk: T; score: number }> = [];
  let droppedByFloor = 0;

  // Provider order is descending relevance; sorting again makes this robust to
  // a provider that does not guarantee it.
  for (const { index, score } of [...scores].sort((a, b) => b.score - a.score)) {
    if (!Number.isInteger(index) || index < 0 || index >= chunks.length) continue;
    if (seen.has(index)) continue;
    seen.add(index);

    if (score < minScore) { droppedByFloor++; continue; }
    ordered.push({ chunk: chunks[index]!, score });
  }

  return {
    kept: ordered.map((o) => o.chunk),
    keptScores: ordered.map((o) => o.score),
    droppedByFloor,
  };
}

export interface RerankOutcome<T> {
  results: T[];
  /** Rerank scores of the kept results, best first. Empty when rerank did not run. */
  scores: number[];
  /** Why the outcome looks the way it does — surfaced in logs and the eval. */
  status: 'reranked' | 'disabled' | 'skipped-empty' | 'failed';
}

/**
 * Rerank `chunks` against `query`, falling back to the input on any problem.
 *
 * `rerankFn` is the provider call. Injecting it keeps this module free of the
 * Pinecone client, so the tests below need no credentials and the caller
 * chooses the model.
 */
export async function rerankChunks<T extends RerankableChunk>(
  query: string,
  chunks: T[],
  options: {
    enabled: boolean;
    minScore: number;
    rerankFn: (query: string, documents: string[]) => Promise<RerankScore[]>;
    logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  },
): Promise<RerankOutcome<T>> {
  if (!options.enabled)   return { results: chunks, scores: [], status: 'disabled' };
  if (chunks.length === 0) return { results: chunks, scores: [], status: 'skipped-empty' };

  try {
    const scores = await options.rerankFn(query, chunks.map((c) => c.text));
    const { kept, keptScores, droppedByFloor } = applyRerankScores(chunks, scores, options.minScore);

    // Dropping everything is a legitimate and important outcome: it is how an
    // off-topic query that cleared the embedding floor gets abstained on.
    if (kept.length === 0 && droppedByFloor > 0) {
      return { results: [], scores: [], status: 'reranked' };
    }
    return { results: kept, scores: keptScores, status: 'reranked' };
  } catch (err) {
    // Fail soft: relevance refinement must never break an answer.
    options.logger?.warn('[rerank] failed; falling back to embedding order', {
      error: (err as Error).message,
    });
    return { results: chunks, scores: [], status: 'failed' };
  }
}
