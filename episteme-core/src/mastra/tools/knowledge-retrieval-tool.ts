import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Pinecone } from '@pinecone-database/pinecone';
import { embedTexts, buildSparseVector } from '../ingestion/embedder';
import { RETRIEVAL_CONFIG, RERANK_CONFIG } from '../config';
import { resolveNamespacesForRoles, buildRetrievalFilter } from '../security/retrieval-gate';
import { getSessionContext } from '../server/session-context';
import { rerankChunks } from './rerank';
import type { RelevanceJudge } from './relevance-gate';


function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

const UserRole = z.enum(['prospective', 'student', 'parent', 'staff', 'hod']).default('prospective');

export type KnowledgeRetrievalResult = {
  chunkId: string;
  content: string;   // parent chunk text — full context for LLM
  source: string;
  /**
   * The document's own content date, or null when the source carries no date
   * at all (typically a scraped web page). Null is "unknown age", NOT "old" —
   * see staleWarning.
   */
  updatedAt: string | null;
  /**
   * Set only when the content date is KNOWN and older than the freshness
   * threshold. An undated source never carries this warning: asserting that
   * something "may be outdated" is a claim about its age, and we have none.
   * The context builder tells the reader it is undated instead.
   */
  staleWarning: string | null;
  /** Page this chunk was extracted from, when the source document has pages
   *  (PDFs). Ingestion stores -1 for sourceless content (scraped HTML); that
   *  sentinel is normalized to null here. */
  pageNumber: number | null;
};

export type KnowledgeRetrievalResponse =
  | {
      found: true;
      results: KnowledgeRetrievalResult[];
      /**
       * Best EMBEDDING score. NOT a relevance gate on its own once a
       * cross-encoder has ruled — see `judgedBy` and tools/relevance-gate.ts.
       */
      maxScore: number;
      /**
       * Which judge decided this result set: the cross-encoder when reranking
       * ran, otherwise embedding similarity. Callers must gate through
       * clearsRelevanceGate rather than comparing maxScore themselves, or a
       * rerank-approved result gets vetoed by a threshold on a different scale.
       */
      judgedBy: RelevanceJudge;
    }
  | { found: false; results: []; message: string };

/**
 * Scale dense and sparse vectors for Pinecone's convex hybrid blend.
 * alpha=1.0 → pure dense (semantic), alpha=0.0 → pure sparse (keyword).
 *
 * Scaling the query vector scales the returned score by the same factor, so the
 * thresholds in RETRIEVAL_CONFIG are only meaningful while alpha=1.0. See the
 * note on `alpha` in config.ts before lowering it.
 *
 * Returns weightedSparse=null at alpha=1.0: every sparse value would be zero,
 * so sending it is pure overhead.
 */
function weightVectors(
  dense: number[],
  sparse: { indices: number[]; values: number[] },
  alpha: number,
) {
  if (alpha >= 1) return { weightedDense: dense, weightedSparse: null };

  return {
    weightedDense: dense.map((v) => v * alpha),
    weightedSparse: {
      indices: sparse.indices,
      values:  sparse.values.map((v) => v * (1 - alpha)),
    },
  };
}

function isDaysOld(isoDate: string, days: number): boolean {
  const then = new Date(isoDate).getTime();
  if (!Number.isFinite(then)) return false; // unparseable — unknown, not old
  const now = Date.now();
  return (now - then) / (1000 * 60 * 60 * 24) > days;
}

/**
 * Sort key for content recency. Undated and unparseable sources sort LAST
 * among equally-relevant matches: given two chunks that answer the question
 * equally well, a known date is better evidence than no date.
 *
 * Returns -Infinity rather than NaN so the comparator stays a total order —
 * NaN propagates through `b - a` and makes Array.sort's behaviour undefined.
 */
function contentTime(updatedAt: unknown): number {
  if (typeof updatedAt !== 'string' || !updatedAt) return Number.NEGATIVE_INFINITY;
  const t = new Date(updatedAt).getTime();
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

const pinecone = new Pinecone({ apiKey: getEnv('PINECONE_API_KEY') });
const pineconeIndex = pinecone.index({ name: getEnv('PINECONE_INDEX') });

type ScoredMatch = { score: number; metadata: Record<string, unknown> };

/**
 * Cross-encoder rerank of the retrieved candidates, via Pinecone's hosted
 * inference. Decision rules live in rerank.ts (pure, unit tested); this only
 * supplies the provider call and the text field.
 *
 * `emptiedByRerank` distinguishes "the judge rejected everything" — a real
 * abstention signal — from "rerank is off or failed", which must not abstain.
 */
async function rerankMatches(
  query: string,
  matches: ScoredMatch[],
): Promise<{ matches: ScoredMatch[]; emptiedByRerank: boolean; judged: boolean }> {
  if (!RERANK_CONFIG.enabled || matches.length === 0) {
    return { matches, emptiedByRerank: false, judged: false };
  }

  const candidates = matches.slice(0, RERANK_CONFIG.topN).map((m) => ({
    match: m,
    // The child chunk is what was embedded and is tighter than the parent, so
    // it is the fairer unit for a relevance judgement.
    text: String(m.metadata['text'] ?? m.metadata['parentText'] ?? ''),
  }));

  const outcome = await rerankChunks(query, candidates, {
    enabled: true,
    minScore: RERANK_CONFIG.minScore,
    rerankFn: async (q, documents) => {
      const response = await pinecone.inference.rerank({
        model: RERANK_CONFIG.model,
        query: q,
        documents,
        topN: documents.length,
        returnDocuments: false,
      });
      return (response.data ?? []).map((row) => ({
        index: row.index as number,
        score: row.score as number,
      }));
    },
  });

  if (outcome.status !== 'reranked') {
    // Disabled, empty, or failed — keep embedding order, never abstain on it,
    // and leave the embedding threshold as the relevance gate.
    return { matches, emptiedByRerank: false, judged: false };
  }

  return {
    matches: outcome.results.map((c) => c.match),
    emptiedByRerank: outcome.results.length === 0,
    judged: true,
  };
}

export async function retrieveKnowledge(inputData: {
  query: string;
  /** Single role — kept for existing callers. Ignored when `roles` is given. */
  role: z.infer<typeof UserRole>;
  /**
   * The caller's full verified role set. Access is the UNION across these, not
   * the single highest-priority one: a user who is both an admin and a student
   * must still retrieve student-tagged documents. Omitted → `[role]`.
   */
  roles?: z.infer<typeof UserRole>[];
  /** Optional programme scope — narrows results to programme-specific + general docs */
  programme?: string;
  /** Optional level scope e.g. "300L", "MSc" — narrows to level-specific + unscoped docs */
  level?: string;
  /**
   * Trust level (1–4) from the authenticated session.
   * Hard-gated against TRUST_NAMESPACES — role claims cannot exceed this ceiling.
   * Defaults to 1 (public-only) when not provided.
   */
  trustLevel?: number;
  /**
   * Institution UUID for multi-tenant isolation.
   * Retrieval always filters: { $in: [institutionId, GLOBAL_INSTITUTION] }
   * — institution-specific docs AND globally shared docs are returned,
   * but cross-tenant data never leaks.
   * Omitting this falls back to GLOBAL_INSTITUTION (shared docs only).
   */
  institutionId?: string;
  /**
   * Optional explicit namespace allowlist — used to enforce parent link permissions.
   * Computed server-side from parent_student_links.can_view_fees / can_view_academic.
   */
  namespaceAllowlist?: string[];
}): Promise<KnowledgeRetrievalResponse> {
  const {
    query, role, roles, programme, level,
    trustLevel = 1, institutionId, namespaceAllowlist,
  } = inputData;

  // A single role is just a one-element set — identical behaviour to before.
  const roleList = roles && roles.length > 0 ? roles : [role];

  // Institutional namespaces only. Platform documentation is not in Pinecone —
  // it is served from disk by tools/platform-docs-tier.ts.
  const namespaces = resolveNamespacesForRoles({
    roles: roleList, trustLevel, namespaceAllowlist,
  });

  const [denseVector] = await embedTexts([query]);
  const sparseVector  = buildSparseVector(query);
  const { weightedDense, weightedSparse } = weightVectors(denseVector, sparseVector, RETRIEVAL_CONFIG.alpha);

  // Role scoping + multi-tenant isolation. Institution A never sees B's vectors.
  const pineconeFilter = buildRetrievalFilter({ role: roleList, programme, level, institutionId });

  const allMatches: Array<{ score: number; metadata: Record<string, unknown> }> = [];

  const results = await Promise.allSettled(
    namespaces.map((ns) =>
      pineconeIndex.namespace(ns).query({
        vector: weightedDense,
        ...(weightedSparse ? { sparseVector: weightedSparse } : {}),
        topK: RETRIEVAL_CONFIG.topK,
        includeMetadata: true,
        filter: pineconeFilter,
      })
    )
  );

  for (const result of results) {
    if (result.status === 'rejected') continue;
    for (const match of result.value.matches) {
      if (match.score && match.score > RETRIEVAL_CONFIG.scoreThreshold && match.metadata) {
        allMatches.push({ score: match.score, metadata: match.metadata as Record<string, unknown> });
      }
    }
  }

  if (allMatches.length === 0) {
    return {
      found: false,
      results: [],
      message: 'No specific information was found for that query. Advise the user to contact the relevant office directly.',
    };
  }

  const maxScore = Math.max(...allMatches.map((m) => m.score));

  // Relevance is the primary signal — Pinecone's score is the only real
  // measure of "does this chunk answer the question." But within a band of
  // near-equal relevance, prefer the more recently updated document: two
  // chunks that are equally on-topic shouldn't leave the answer to pick
  // whichever happened to embed marginally closer, when one of them is known
  // to be stale. Outside that band, relevance still wins — a newer but
  // off-topic chunk must never outrank the actually-relevant one.
  const RELEVANCE_TIE_EPSILON = 0.02;
  allMatches.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > RELEVANCE_TIE_EPSILON) return scoreDiff;
    // Within a near-equal relevance band, prefer the more recent CONTENT
    // (updatedAt = the document's own editorial date). Content recency — not
    // when we happened to load the file — is what makes one of two equally
    // on-topic chunks the better answer. Undated chunks sort last; see
    // contentTime for why they are not simply NaN.
    const aTime = contentTime(a.metadata['updatedAt']);
    const bTime = contentTime(b.metadata['updatedAt']);
    if (aTime === bTime) return 0;
    return bTime - aTime;
  });

  // Cross-encoder pass over the top candidates BEFORE parent dedupe and
  // capping, so the model sees the passages a relevance judge actually chose
  // rather than the ones a bi-encoder happened to embed closest. Fail-soft:
  // any rerank problem leaves `allMatches` in embedding order. See rerank.ts.
  const reranked = await rerankMatches(query, allMatches);
  if (reranked.emptiedByRerank) {
    // Every candidate was judged irrelevant — this is abstention, and it is the
    // case embedding similarity could not detect ("how do I apply to Harvard").
    return {
      found: false,
      results: [],
      message: 'No specific information was found for that query. Advise the user to contact the relevant office directly.',
    };
  }
  const orderedMatches = reranked.matches;

  const seenParents = new Set<string>();
  const retrievalResults: KnowledgeRetrievalResult[] = [];

  for (const match of orderedMatches) {
    if (retrievalResults.length >= RETRIEVAL_CONFIG.maxResults) break;
    const parentId = match.metadata['parentId'] as string;
    if (seenParents.has(parentId)) continue;
    seenParents.add(parentId);

    // Absent for a genuinely undated source — ingestion omits the key rather
    // than writing a placeholder date. See IngestOptions.updatedAt.
    const rawUpdatedAt = match.metadata['updatedAt'];
    const updatedAt =
      typeof rawUpdatedAt === 'string' && rawUpdatedAt ? rawUpdatedAt : null;
    // Staleness is measured from the document's own CONTENT date (updatedAt),
    // NOT when we loaded it (ingestedAt). A handbook re-ingested today can still
    // hold a 2022 fact (e.g. a former VC's name) — only the content's own age
    // reveals it may be outdated. When a match is flagged stale, the grounded
    // cascade first defers to a fresher tier (news/web) if one can answer, and
    // only otherwise returns this content WITH the caveat below — so a stale
    // fact never silently wins over a live one. See grounded-response-tool.ts.
    const rawPage = match.metadata['pageNumber'] as number | undefined;
    const pageNumber = typeof rawPage === 'number' && rawPage >= 0 ? rawPage : null;

    retrievalResults.push({
      chunkId:      match.metadata['chunkId']     as string,
      content:      match.metadata['parentText']  as string,
      source:       match.metadata['source']      as string,
      updatedAt,
      // Only a KNOWN-old date earns the warning. An undated source gets null
      // here and is surfaced to the reader as undated instead — claiming it
      // "may be outdated" would assert an age we do not have.
      staleWarning:
        updatedAt && isDaysOld(updatedAt, RETRIEVAL_CONFIG.freshnessThresholdDays)
          ? '⚠️ This information may be outdated. Please verify with the relevant office before acting on it.'
          : null,
      pageNumber,
    });
  }

  return {
    found: true,
    results: retrievalResults,
    maxScore,
    judgedBy: reranked.judged ? 'rerank' : 'embedding',
  };
}

export const knowledgeRetrievalTool = createTool({
  id: 'knowledgeRetrievalTool',
  description:
    'Low-level knowledge base search for the University of Benin (Uniben). ' +
    'Covers policies, admissions, academic regulations, financial aid, programmes, announcements, and general information. ' +
    'The caller\'s role, trust level, institution, and namespace allowlist are attached server-side ' +
    'from the authenticated session — they are not parameters and cannot be chosen. ' +
    'For agent use, prefer groundedResponseTool which wraps this with query rewriting, relevance gating, and grounded context formatting. ' +
    'Use this tool directly only when raw retrieval results are needed without synthesis.',
  inputSchema: z.object({
    query: z.string().describe('The user question or topic to retrieve information about.'),
    programme: z
      .string()
      .optional()
      .describe('Optional programme scope to narrow results e.g. "Computer Science".'),
    level: z
      .string()
      .optional()
      .describe(
        'Optional academic level scope e.g. "300L", "MSc". ' +
        'Read from system context field level=<value>. Omit if unknown.'
      ),
  }),
  execute: async (inputData, context) => {
    const { query, programme, level } = inputData as {
      query: string;
      programme?: string;
      level?: string;
    };
    // Security-critical values come ONLY from the server-injected session
    // context (chat-security middleware) — never from model-controlled input.
    const session = getSessionContext(context?.requestContext);
    return await retrieveKnowledge({
      query,
      role:               session.role,
      roles:              session.roles,
      programme,
      level,
      trustLevel:         session.trustLevel,
      institutionId:      session.institutionId,
      namespaceAllowlist: session.namespaceAllowlist,
    });
  },
});
