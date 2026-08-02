// episteme-core/src/mastra/config.ts
/**
 * Centralised runtime configuration for Episteme.
 * All tunable constants are read from environment variables at startup.
 * Defaults are production-calibrated — override in .env for environment-specific tuning.
 */


function envInt(key: string, defaultVal: number): number {
  const raw = process.env[key];
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : defaultVal;
}

function envFloat(key: string, defaultVal: number): number {
  const raw = process.env[key];
  if (!raw) return defaultVal;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : defaultVal;
}

function envString(key: string, defaultVal: string): string {
  return process.env[key] ?? defaultVal;
}

function envStringList(key: string, defaultVal: string[]): string[] {
  const raw = process.env[key];
  if (!raw) return defaultVal;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Like envStringList, but a value that parses to NOTHING falls back to the
 * default instead of to an empty list.
 *
 * Used for allowlists, where "empty" must never be read as "no restriction".
 * WEB_SEARCH_INCLUDE_DOMAINS=" " or "," parsed to [], which the search tool
 * turned into an unrestricted search of the entire internet — a whitespace
 * typo silently removed the domain scope. An allowlist has to fail closed.
 */
function envAllowlist(key: string, defaultVal: string[]): string[] {
  const parsed = envStringList(key, defaultVal);
  return parsed.length > 0 ? parsed : defaultVal;
}

function envBool(key: string, defaultVal: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return defaultVal;
  return raw.trim().toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// Chunking — controls parent/child split sizes for the ingestion pipeline
// ---------------------------------------------------------------------------
export const CHUNK_CONFIG = {
  /** Parent chunk size in chars — returned to LLM as context (~500 tokens) */
  parentSize: envInt('CHUNK_PARENT_SIZE', 2048),
  parentOverlap: envInt('CHUNK_PARENT_OVERLAP', 200),
  /** Child chunk size in chars — used for vector retrieval (~125 tokens) */
  childSize: envInt('CHUNK_CHILD_SIZE', 512),
  childOverlap: envInt('CHUNK_CHILD_OVERLAP', 64),
  /** Minimum child text length — drop chunks shorter than this */
  minChildLength: envInt('CHUNK_MIN_CHILD_LENGTH', 10),
} as const;

// ---------------------------------------------------------------------------
// Embedding — batch size for dense vector generation
// ---------------------------------------------------------------------------
export const EMBED_CONFIG = {
  batchSize: envInt('EMBED_BATCH_SIZE', 32),
} as const;

// ---------------------------------------------------------------------------
// Ingestion — Pinecone upsert and retry settings
// ---------------------------------------------------------------------------
export const INGEST_CONFIG = {
  upsertBatchSize: envInt('PINECONE_UPSERT_BATCH_SIZE', 100),
  retryAttempts: envInt('PINECONE_RETRY_ATTEMPTS', 3),
  retryBaseDelayMs: envInt('PINECONE_RETRY_BASE_DELAY_MS', 500),
} as const;

// ---------------------------------------------------------------------------
// Retrieval — controls vector search quality and result capping
// ---------------------------------------------------------------------------
export const RETRIEVAL_CONFIG = {
  /** Number of candidates fetched per namespace from Pinecone */
  topK: envInt('RETRIEVAL_TOP_K', 5),
  /**
   * Minimum dotproduct score to accept a match.
   * mistral-embed produces normalised vectors → scores in 0.0–1.0.
   * 0.3 filters noise without being overly restrictive.
   * Only true while alpha=1.0 — see the note on `alpha` below.
   */
  scoreThreshold: envFloat('RETRIEVAL_SCORE_THRESHOLD', 0.3),
  /** Maximum unique parent chunks returned to the LLM */
  maxResults: envInt('RETRIEVAL_MAX_RESULTS', 3),
  /** Flag results whose source document is older than this many days */
  freshnessThresholdDays: envInt('RETRIEVAL_FRESHNESS_THRESHOLD_DAYS', 365),
  /**
   * Hybrid search blend factor (0.0–1.0).
   * 1.0 = pure dense (semantic), 0.0 = pure sparse (keyword).
   *
   * MUST stay 1.0 until sparse vectors are normalised. Pinecone scores a
   * convex blend as `alpha*dot(dense) + (1-alpha)*dot(sparse)`, which is only
   * meaningful when both terms share a scale. They don't: dense is cosine
   * (~0.7) while buildSparseVector emits raw term frequencies (~0.03), so the
   * sparse term contributed ~0.002 — 0.2% of the score — while alpha deflated
   * every dense score by 25%. Measured: a chunk scoring 0.734 arrived as 0.551
   * against a 0.55 gate, so real matches abstained on a coin flip.
   *
   * Restoring hybrid properly means L2-normalising sparse vectors on BOTH the
   * query and document side (a re-ingest), or switching to reciprocal rank
   * fusion. Until then a lower alpha only re-introduces the deflation.
   */
  alpha: envFloat('RETRIEVAL_ALPHA', 1.0),
  /**
   * Minimum maxScore to treat results as genuinely relevant (not just "above noise floor").
   * When the best match scores below this, retrieval returns abstention even if found=true.
   *
   * MEASURED, not guessed (pnpm eval:retrieval --scores, 2026-08-02, 454-vector corpus):
   *
   *   in-domain (12 queries)      0.694 – 0.808
   *   out-of-domain (10 probes)   0.611 – 0.744
   *
   * At the previous value of 0.55, ALL TEN out-of-domain probes were answered —
   * "how do I bake sourdough bread" returned handbook chunks as VERIFIED SOURCES
   * at confidence=high. The gate was effectively inert (54.5% accuracy).
   *
   * 0.68 sits just under the lowest observed in-domain score and cuts
   * out-of-domain answers from 10/10 to 3/10 with no in-domain loss on that
   * sample.
   *
   * THIS IS TRIAGE, NOT THE FIX. The two distributions OVERLAP (margin -0.051):
   * "weather in Benin City" (0.744) and "how do I apply to Harvard University"
   * (0.712) both outscore the weakest genuine query ("who is the current vice
   * chancellor", 0.694). No scalar cutoff can separate them, because both share
   * heavy vocabulary with the corpus while answering nothing in it. The real
   * signal is a cross-encoder — see RERANK_CONFIG below, which is what actually
   * targets that class.
   *
   * Note the thin margin: 0.68 leaves only ~0.014 below the weakest genuine
   * query, on a sample of 12. Re-run --scores after labelling more in-domain
   * queries before trusting it further, and treat 0.694 as a canary.
   */
  relevanceThreshold: envFloat('RETRIEVAL_RELEVANCE_THRESHOLD', 0.68),
} as const;

// ---------------------------------------------------------------------------
// Reranking — cross-encoder relevance over the retrieved candidates
// ---------------------------------------------------------------------------
/**
 * The measured fix for what relevanceThreshold cannot do (see its comment).
 *
 * A bi-encoder embeds query and document separately, so it scores topical
 * overlap: "weather in Benin City" hits a Uniben handbook at 0.744 because both
 * are about Benin and a university. A cross-encoder reads the pair together and
 * scores whether the passage ANSWERS the query, which is the signal the score
 * distributions say is missing.
 *
 * Runs through Pinecone's hosted inference — no new vendor, same API key.
 *
 * Costs one extra network round-trip per retrieval. It is FAIL-SOFT: any error
 * falls back to embedding order (see rerank.ts), so it can degrade relevance
 * but never break an answer.
 */
export const RERANK_CONFIG = {
  /**
   * Off by default so this ships dark: enable it deliberately, after running
   * `pnpm eval:retrieval --scores` to calibrate minScore against YOUR corpus.
   * A relevance floor copied from someone else's data is how 0.55 happened.
   */
  enabled: envBool('RERANK_ENABLED', false),
  /** Pinecone-hosted cross-encoder. */
  model: envString('RERANK_MODEL', 'bge-reranker-v2-m3'),
  /**
   * Minimum cross-encoder score to keep a chunk. Unlike embedding similarity,
   * these scores are calibrated probabilities of relevance, so a low value is
   * genuinely low — but the right cutoff is still corpus-specific. Measure it.
   */
  minScore: envFloat('RERANK_MIN_SCORE', 0.3),
  /** Candidates to rerank. More candidates = better recall, slightly more cost. */
  topN: envInt('RERANK_TOP_N', 10),
} as const;

// ---------------------------------------------------------------------------
// Platform documentation — product docs served from src/content/platform
// ---------------------------------------------------------------------------
export const PLATFORM_DOCS_CONFIG = {
  /**
   * Minimum fraction (0–1) of a query's distinct content terms that must appear
   * in a section for it to count as an answer. This is the abstention gate for
   * the platform tier, and the analogue of RETRIEVAL_CONFIG.relevanceThreshold.
   *
   * 0.5 = "at least half the real query words appear in the section". Lower and
   * an unrelated section answers a specific question; higher and a well-phrased
   * question that uses one synonym abstains. Ranking within the surviving set
   * is BM25 — see rankSections.
   */
  minCoverage: envFloat('PLATFORM_DOCS_MIN_COVERAGE', 0.5),
  /**
   * Coverage at which a section qualifies WITHOUT matching the query in its own
   * heading. Below this, a section must be headed by something the query names —
   * otherwise these docs' university examples ("a fees document placed in
   * General") capture genuine institutional questions. See rankSections.
   */
  strongCoverage: envFloat('PLATFORM_DOCS_STRONG_COVERAGE', 0.75),
  /** Maximum sections handed to the model. Matches RETRIEVAL_MAX_RESULTS. */
  maxResults: envInt('PLATFORM_DOCS_MAX_RESULTS', 3),
} as const;

// ---------------------------------------------------------------------------
// Web search — Tavily-powered live context retrieval
// ---------------------------------------------------------------------------
export const WEB_SEARCH_CONFIG = {
  maxResults: envInt('WEB_SEARCH_MAX_RESULTS', 3),
  /**
   * Comma-separated allowlist of domains web search may return, including
   * subdomains. Scoped to Uniben and Nigerian academic authorities by default.
   *
   * FAILS CLOSED: a value that parses to nothing (empty, " ", ",") falls back to
   * this default rather than removing the restriction. It previously did the
   * opposite — a whitespace typo produced an empty list, which the search tool
   * sent to Tavily as "no domain filter", and a question about onboarding staff
   * in Episteme came back answered from a SaaS vendor's HR blog.
   *
   * To genuinely search the whole web, set WEB_SEARCH_ALLOW_ANY_DOMAIN=true.
   * Widening scope should take a deliberate, greppable flag — never the absence
   * of a value.
   */
  includeDomains: envAllowlist(
    'WEB_SEARCH_INCLUDE_DOMAINS',
    ['uniben.edu', 'nuc.edu.ng', 'jamb.gov.ng', 'tetfund.gov.ng'],
  ),
  /** Explicit opt-in to unrestricted web search. Off unless set to "true". */
  allowAnyDomain: envBool('WEB_SEARCH_ALLOW_ANY_DOMAIN', false),
  /** 'basic' for speed, 'advanced' for richer content extraction */
  searchDepth: envString('WEB_SEARCH_DEPTH', 'advanced') as 'basic' | 'advanced',
  /** Score threshold — Tavily scores range 0.0–1.0 */
  scoreThreshold: envFloat('WEB_SEARCH_SCORE_THRESHOLD', 0.5),
} as const;

// ---------------------------------------------------------------------------
// UNIBEN Live News — WP REST API fetch settings
// ---------------------------------------------------------------------------
export const UNIBEN_NEWS_CONFIG = {
  maxResults: envInt('UNIBEN_NEWS_MAX_RESULTS', 10),
  timeoutMs:  envInt('UNIBEN_NEWS_TIMEOUT_MS', 8000),
  /**
   * Minimum topical-overlap score (0–1) a news post must clear to be used as a
   * *fallback answer* inside groundedResponseTool's cascade. The explicit
   * unibenNewsTool ignores this (defaults to 0) — a user asking for "latest
   * news" wants the feed regardless. But the cascade must not let an off-topic
   * feed pose as an answer to a specific factual question, so a post needs at
   * least this fraction of the query's topical tokens (institution name and
   * function words excluded). 0.34 ≈ "at least a third of the real query words
   * appear in the post." Raise to cut off-topic news; lower if it over-filters.
   */
  fallbackMinScore: envFloat('UNIBEN_NEWS_FALLBACK_MIN_SCORE', 0.34),
} as const;