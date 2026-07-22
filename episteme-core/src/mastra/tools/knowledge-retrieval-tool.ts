import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Pinecone } from '@pinecone-database/pinecone';
import { embedTexts, buildSparseVector } from '../ingestion/embedder';
import { RETRIEVAL_CONFIG } from '../config';
import { resolveNamespaces, buildRetrievalFilter } from '../security/retrieval-gate';
import { getSessionContext } from '../server/session-context';

declare const process: { env: Record<string, string | undefined> };

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
  updatedAt: string;
  staleWarning: string | null;
  /** Page this chunk was extracted from, when the source document has pages
   *  (PDFs). Ingestion stores -1 for sourceless content (scraped HTML); that
   *  sentinel is normalized to null here. */
  pageNumber: number | null;
};

export type KnowledgeRetrievalResponse =
  | { found: true; results: KnowledgeRetrievalResult[]; maxScore: number }
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
  const now = Date.now();
  return (now - then) / (1000 * 60 * 60 * 24) > days;
}

const pinecone = new Pinecone({ apiKey: getEnv('PINECONE_API_KEY') });
const pineconeIndex = pinecone.index({ name: getEnv('PINECONE_INDEX') });

export async function retrieveKnowledge(inputData: {
  query: string;
  role: z.infer<typeof UserRole>;
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
  const { query, role, programme, level, trustLevel = 1, institutionId, namespaceAllowlist } = inputData;

  // Both gates live in security/retrieval-gate.ts — pure and unit-tested there.
  const namespaces = resolveNamespaces({ role, trustLevel, namespaceAllowlist });

  const [denseVector] = await embedTexts([query]);
  const sparseVector  = buildSparseVector(query);
  const { weightedDense, weightedSparse } = weightVectors(denseVector, sparseVector, RETRIEVAL_CONFIG.alpha);

  // Role scoping + multi-tenant isolation. Institution A never sees B's vectors.
  const pineconeFilter = buildRetrievalFilter({ role, programme, level, institutionId });

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
    // on-topic chunks the better answer.
    const aTime = new Date(a.metadata['updatedAt'] as string).getTime();
    const bTime = new Date(b.metadata['updatedAt'] as string).getTime();
    return bTime - aTime;
  });

  const seenParents = new Set<string>();
  const retrievalResults: KnowledgeRetrievalResult[] = [];

  for (const match of allMatches) {
    if (retrievalResults.length >= RETRIEVAL_CONFIG.maxResults) break;
    const parentId = match.metadata['parentId'] as string;
    if (seenParents.has(parentId)) continue;
    seenParents.add(parentId);

    const updatedAt = match.metadata['updatedAt'] as string;
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
      staleWarning: isDaysOld(updatedAt, RETRIEVAL_CONFIG.freshnessThresholdDays)
        ? '⚠️ This information may be outdated. Please verify with the relevant office before acting on it.'
        : null,
      pageNumber,
    });
  }

  return { found: true, results: retrievalResults, maxScore };
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
      programme,
      level,
      trustLevel:         session.trustLevel,
      institutionId:      session.institutionId,
      namespaceAllowlist: session.namespaceAllowlist,
    });
  },
});
