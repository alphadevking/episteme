// episteme-core/src/evals/retrieval-metrics.ts
/**
 * Information-retrieval metrics for the retrieval eval.
 *
 * Deliberately pure — no Pinecone, no embeddings, no env. The scoring rules are
 * the part that must be right and must never drift, so they are unit-tested
 * without credentials (retrieval-metrics.test.ts) and run in the normal
 * `pnpm test` suite. The runner that actually calls Pinecone is a script.
 *
 * WHY THESE METRICS
 *   precision@k — of the k chunks we showed the model, what fraction should
 *     have been there. This is the one that matters most here: every irrelevant
 *     chunk in the context is an opportunity for the model to cite something
 *     that does not answer the question.
 *   recall@k — of the documents that should have been found, what fraction we
 *     surfaced. Catches the silent failure where retrieval returns something
 *     plausible and misses the document that actually answers.
 *   MRR — how far down the list the first correct document sits. Position
 *     matters because RETRIEVAL_MAX_RESULTS caps what reaches the model.
 *   nDCG@k — rank-weighted correctness, so being right at position 1 beats
 *     being right at position 3. Binary gains (relevant / not).
 *
 * ABSTENTION is scored separately and is not an IR metric: for an out-of-domain
 * query the correct behaviour is to return nothing. Averaging that into
 * precision would let a system that answers nothing score well.
 */

/** A retrieved item reduced to the identity the golden set labels against. */
export interface RetrievedItem {
  /** `source` from KnowledgeRetrievalResult — a URL or file name. */
  source: string;
  score: number;
}

/**
 * Case-insensitive substring match of a retrieved source against a label.
 *
 * Substring rather than equality because a label like `student-handbook.pdf`
 * should match the stored source whether it was ingested as a bare file name or
 * a full URL. Labels are therefore written to be distinctive enough not to
 * collide — the runner warns when a label matches nothing at all, which is the
 * failure mode that would silently zero a case's score.
 */
export function matchesLabel(source: string, label: string): boolean {
  return source.toLowerCase().includes(label.toLowerCase());
}

/** True when this retrieved item matches any labelled-relevant source. */
export function isRelevant(item: RetrievedItem, relevantLabels: string[]): boolean {
  return relevantLabels.some((label) => matchesLabel(item.source, label));
}

/**
 * Fraction of the top-k retrieved items that are relevant.
 *
 * Denominator is min(k, retrieved.length), not k: returning 2 correct results
 * when only 2 exist is precision 1.0, not 0.67. Penalising a system for the
 * corpus containing fewer than k relevant documents measures the corpus.
 */
export function precisionAtK(retrieved: RetrievedItem[], relevantLabels: string[], k: number): number {
  const topK = retrieved.slice(0, k);
  if (topK.length === 0) return 0;
  const hits = topK.filter((item) => isRelevant(item, relevantLabels)).length;
  return hits / topK.length;
}

/**
 * Fraction of labelled-relevant documents that appear in the top k.
 *
 * Counts distinct LABELS matched, not items: three chunks from the same
 * document are one document found, and counting them as three would report
 * recall above 1.0 whenever a document chunks into several hits.
 */
export function recallAtK(retrieved: RetrievedItem[], relevantLabels: string[], k: number): number {
  if (relevantLabels.length === 0) return 0;
  const topK = retrieved.slice(0, k);
  const found = relevantLabels.filter((label) =>
    topK.some((item) => matchesLabel(item.source, label)),
  ).length;
  return found / relevantLabels.length;
}

/** 1/rank of the first relevant item (1-indexed), or 0 if none is relevant. */
export function reciprocalRank(retrieved: RetrievedItem[], relevantLabels: string[]): number {
  const idx = retrieved.findIndex((item) => isRelevant(item, relevantLabels));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

/**
 * nDCG@k with binary gains.
 *
 * DCG = Σ rel_i / log2(i + 1) over the top k, normalised by the ideal ordering
 * (every relevant document first). Ideal is capped at min(k, |relevant|) so a
 * case with more labels than k can still reach 1.0 — otherwise the ceiling
 * would be unreachable and every case would look worse than it is.
 */
export function ndcgAtK(retrieved: RetrievedItem[], relevantLabels: string[], k: number): number {
  if (relevantLabels.length === 0) return 0;

  // Credit each labelled DOCUMENT once, at its best-ranked chunk.
  //
  // Retrieval returns chunks, and several chunks routinely come from the same
  // document. Scoring each as an independent relevant item inflates DCG past
  // the ideal — a real run scored 2.131 because three chunks of one document
  // were credited against an ideal built from one label. Gains are per
  // document, matching how recallAtK counts distinct labels.
  const credited = new Set<string>();
  let dcg = 0;
  retrieved.slice(0, k).forEach((item, i) => {
    const newLabel = relevantLabels.find(
      (label) => !credited.has(label) && matchesLabel(item.source, label),
    );
    if (newLabel) {
      credited.add(newLabel);
      dcg += 1 / Math.log2(i + 2);
    }
  });

  const idealHits = Math.min(k, relevantLabels.length);
  const idcg = Array.from({ length: idealHits }, (_, i) => 1 / Math.log2(i + 2))
    .reduce((a, b) => a + b, 0);

  return idcg === 0 ? 0 : dcg / idcg;
}

export interface CaseScore {
  precision: number;
  /**
   * precision@1 — was the TOP result right.
   *
   * Reported alongside precision@k because the two answer different questions
   * and get conflated. Measured on the platform corpus, the correct document
   * ranks first on every case while a second, adjacent document rides along:
   * precision@3 lands near 50% while precision@1 is 100%. Without this, that
   * reads as "retrieval is half wrong" when it is actually "retrieval ranks
   * correctly but returns extra context".
   */
  precisionAt1: number;
  recall: number;
  reciprocalRank: number;
  ndcg: number;
  /** True when at least one labelled document was retrieved at all. */
  anyHit: boolean;
}

export function scoreCase(retrieved: RetrievedItem[], relevantLabels: string[], k: number): CaseScore {
  return {
    precision:      precisionAtK(retrieved, relevantLabels, k),
    precisionAt1:   precisionAtK(retrieved, relevantLabels, 1),
    recall:         recallAtK(retrieved, relevantLabels, k),
    reciprocalRank: reciprocalRank(retrieved, relevantLabels),
    ndcg:           ndcgAtK(retrieved, relevantLabels, k),
    anyHit:         retrieved.some((item) => isRelevant(item, relevantLabels)),
  };
}

/** Arithmetic mean, 0 for an empty set (no NaN leaking into a report). */
export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

// ── Threshold calibration ────────────────────────────────────────────────────

export interface SeparationAnalysis {
  /** True when every in-domain score exceeds every out-of-domain score. */
  cleanlySeparable: boolean;
  inDomainMin: number;
  outOfDomainMax: number;
  /** The threshold that classifies the most queries correctly. */
  bestThreshold: number;
  /** In-domain queries that would be wrongly abstained on at bestThreshold. */
  falseAbstain: number;
  /** Out-of-domain queries that would be wrongly answered at bestThreshold. */
  falseAnswer: number;
  accuracy: number;
  /** Margin between the two groups; negative when they overlap. */
  margin: number;
}

/** Classification outcome of a single candidate threshold. */
export function classifyAtThreshold(
  inDomain: number[],
  outOfDomain: number[],
  threshold: number,
): { falseAbstain: number; falseAnswer: number; accuracy: number } {
  const falseAbstain = inDomain.filter((s) => s < threshold).length;
  const falseAnswer  = outOfDomain.filter((s) => s >= threshold).length;
  const total = inDomain.length + outOfDomain.length;
  return {
    falseAbstain,
    falseAnswer,
    accuracy: total === 0 ? 0 : (total - falseAbstain - falseAnswer) / total,
  };
}

/**
 * Find the relevance threshold best separating queries that SHOULD retrieve
 * from queries that should abstain.
 *
 * The honest outcome of this function is often "no threshold works". When the
 * groups overlap, `cleanlySeparable` is false and `margin` is negative — that
 * is the evidence that a scalar cutoff on embedding similarity cannot express
 * relevance for this corpus, and that the fix is a better signal (hybrid
 * retrieval, reranking) rather than a better number.
 *
 * Ties are broken toward the HIGHER threshold: given equal accuracy, abstaining
 * on a real question is a worse-but-recoverable outcome ("no verified
 * information found"), while answering an out-of-domain question from unrelated
 * documents is a fabrication. Fail closed.
 */
export function analyzeSeparation(inDomain: number[], outOfDomain: number[]): SeparationAnalysis {
  const inDomainMin    = inDomain.length    ? Math.min(...inDomain)    : 0;
  const outOfDomainMax = outOfDomain.length ? Math.max(...outOfDomain) : 0;

  // Candidates: every observed score, plus a step above each out-of-domain
  // score (the threshold must EXCEED it to exclude it).
  const candidates = [...new Set([
    ...inDomain,
    ...outOfDomain.map((s) => s + 0.001),
    inDomainMin,
    outOfDomainMax + 0.001,
  ])].sort((a, b) => a - b);

  let best = { threshold: candidates[0] ?? 0, accuracy: -1, falseAbstain: 0, falseAnswer: 0 };
  for (const threshold of candidates) {
    const result = classifyAtThreshold(inDomain, outOfDomain, threshold);
    // `>=` keeps the LAST (highest) threshold among equals — fail closed.
    if (result.accuracy >= best.accuracy) {
      best = { threshold, ...result };
    }
  }

  return {
    cleanlySeparable: inDomain.length > 0 && outOfDomain.length > 0 && inDomainMin > outOfDomainMax,
    inDomainMin,
    outOfDomainMax,
    bestThreshold: best.threshold,
    falseAbstain: best.falseAbstain,
    falseAnswer: best.falseAnswer,
    accuracy: best.accuracy,
    margin: inDomainMin - outOfDomainMax,
  };
}

export interface RetrievalSummary {
  retrievalCases: number;
  precision: number;
  precisionAt1: number;
  recall: number;
  mrr: number;
  ndcg: number;
  /** Cases where nothing labelled was retrieved at all — the outright misses. */
  totalMisses: number;
  abstentionCases: number;
  /** Abstention cases that correctly returned nothing relevant. */
  abstentionCorrect: number;
}

/**
 * Macro-average across cases: every case counts equally regardless of how many
 * documents it labels. Micro-averaging would let one heavily-labelled query
 * dominate the score and hide failures on the rest.
 */
export function summarize(
  retrievalScores: CaseScore[],
  abstentionResults: boolean[],
): RetrievalSummary {
  return {
    retrievalCases:    retrievalScores.length,
    precision:         mean(retrievalScores.map((s) => s.precision)),
    precisionAt1:      mean(retrievalScores.map((s) => s.precisionAt1)),
    recall:            mean(retrievalScores.map((s) => s.recall)),
    mrr:               mean(retrievalScores.map((s) => s.reciprocalRank)),
    ndcg:              mean(retrievalScores.map((s) => s.ndcg)),
    totalMisses:       retrievalScores.filter((s) => !s.anyHit).length,
    abstentionCases:   abstentionResults.length,
    abstentionCorrect: abstentionResults.filter(Boolean).length,
  };
}
