/**
 * Centralised runtime configuration for Episteme.
 * All tunable constants are read from environment variables at startup.
 * Defaults are production-calibrated — override in .env for environment-specific tuning.
 */

declare const process: { env: Record<string, string | undefined> };

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
   */
  scoreThreshold: envFloat('RETRIEVAL_SCORE_THRESHOLD', 0.3),
  /** Maximum unique parent chunks returned to the LLM */
  maxResults: envInt('RETRIEVAL_MAX_RESULTS', 3),
  /** Flag results whose source document is older than this many days */
  freshnessThresholdDays: envInt('RETRIEVAL_FRESHNESS_THRESHOLD_DAYS', 365),
  /**
   * Hybrid search blend factor (0.0–1.0).
   * 1.0 = pure dense (semantic), 0.0 = pure sparse (keyword).
   * 0.75 is calibrated for academic policy queries where semantic
   * similarity matters more than exact keyword matching.
   * Override with RETRIEVAL_ALPHA env var to tune per-environment.
   */
  alpha: envFloat('RETRIEVAL_ALPHA', 0.75),
} as const;

// ---------------------------------------------------------------------------
// Web search — Tavily-powered live context retrieval
// ---------------------------------------------------------------------------
export const WEB_SEARCH_CONFIG = {
  maxResults: envInt('WEB_SEARCH_MAX_RESULTS', 3),
  /**
   * Comma-separated list of domains to include in web searches.
   * Scoped to Uniben and Nigerian academic authorities by default.
   * Set WEB_SEARCH_INCLUDE_DOMAINS= (empty) to search the full web.
   */
  includeDomains: envStringList(
    'WEB_SEARCH_INCLUDE_DOMAINS',
    ['uniben.edu', 'nuc.edu.ng', 'jamb.gov.ng', 'tetfund.gov.ng'],
  ),
  /** 'basic' for speed, 'advanced' for richer content extraction */
  searchDepth: envString('WEB_SEARCH_DEPTH', 'advanced') as 'basic' | 'advanced',
  /** Score threshold — Tavily scores range 0.0–1.0 */
  scoreThreshold: envFloat('WEB_SEARCH_SCORE_THRESHOLD', 0.5),
} as const;
