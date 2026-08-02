// episteme-core/src/mastra/tools/relevance-gate.ts
/**
 * The single relevance decision: may this KB result be shown as an answer?
 *
 * WHY THIS EXISTS: retrieval grew two gates that did not know about each other.
 * `retrieveKnowledge` applies the cross-encoder floor (RERANK_MIN_SCORE), and
 * the grounded cascade then re-checked the EMBEDDING score against
 * RETRIEVAL_RELEVANCE_THRESHOLD. So a chunk the cross-encoder judged genuinely
 * relevant could still be vetoed for embedding at 0.66 — and raising that
 * threshold from 0.55 to 0.68 made the collision more likely.
 *
 * The two numbers are not comparable. Embedding similarity for this corpus sits
 * in a narrow 0.61–0.81 band; bge-reranker scores are calibrated relevance
 * probabilities on a different scale entirely. Tuning them to agree would be
 * coupling two unrelated units — the patch, not the fix.
 *
 * So relevance has exactly one owner per query: whichever judge actually ran.
 * When the cross-encoder ran, its floor already removed everything irrelevant
 * and the embedding score is stale information. When it did not run — disabled,
 * or failed and fell back to embedding order — the embedding threshold is the
 * only signal available and still applies in full.
 */

export type RelevanceJudge = 'rerank' | 'embedding';

export interface GateableRetrieval {
  found: boolean;
  /** Best EMBEDDING score. Meaningless as a gate once a cross-encoder has ruled. */
  maxScore?: number;
  /** Which judge decided this result set. Absent → embedding (fail safe). */
  judgedBy?: RelevanceJudge;
}

/**
 * True when the result may be surfaced as a grounded answer.
 *
 * Fails closed in the ambiguous direction: a missing `judgedBy` is treated as
 * 'embedding', so a caller that forgets to plumb it gets the stricter of the
 * two behaviours rather than a free pass.
 */
export function clearsRelevanceGate<T extends GateableRetrieval>(
  retrieval: T,
  embeddingThreshold: number,
): retrieval is T & { found: true } {
  if (!retrieval.found) return false;

  // The cross-encoder already rejected everything below its floor; anything
  // still here passed a stronger test than embedding similarity could apply.
  if (retrieval.judgedBy === 'rerank') return true;

  return typeof retrieval.maxScore === 'number' && retrieval.maxScore >= embeddingThreshold;
}
