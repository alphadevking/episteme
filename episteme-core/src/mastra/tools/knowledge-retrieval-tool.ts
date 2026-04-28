import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Pinecone } from '@pinecone-database/pinecone';
import { embedTexts, buildSparseVector } from '../ingestion/embedder';
import { RETRIEVAL_CONFIG } from '../config';
import { GLOBAL_INSTITUTION } from '../ingestion/ingest';

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
};

export type KnowledgeRetrievalResponse =
  | { found: true; results: KnowledgeRetrievalResult[]; maxScore: number }
  | { found: false; results: []; message: string };

/**
 * Scale dense and sparse vectors by alpha to control hybrid weighting.
 * alpha=1.0 → pure dense (semantic), alpha=0.0 → pure sparse (keyword).
 * 0.75 is calibrated for academic queries where semantic match dominates.
 */
function weightVectors(
  dense: number[],
  sparse: { indices: number[]; values: number[] },
  alpha: number,
) {
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

/**
 * Role → namespace access mapping.
 * Controls which knowledge domains each user class can search.
 */
const ROLE_NAMESPACES: Record<string, string[]> = {
  prospective: ['admissions', 'programmes', 'general'],
  student: ['academic-policy', 'financial-aid', 'programmes', 'general'],
  parent: ['admissions', 'financial-aid', 'general'],
  staff: ['admissions', 'academic-policy', 'financial-aid', 'programmes', 'staff-internal', 'general'],
  hod: ['admissions', 'academic-policy', 'financial-aid', 'programmes', 'staff-internal', 'general'],
};

/**
 * Trust level → maximum allowed namespaces (hard gate).
 * Actual namespaces = intersection(ROLE_NAMESPACES[role], TRUST_NAMESPACES[trust]).
 *
 *  1 = public-only (unverified / prospective)
 *  2 = programme-info (unverified student)
 *  3 = personal-academic (portal-verified student)
 *  4 = full-access (staff / HOD / superadmin)
 */
const TRUST_NAMESPACES: Record<number, string[]> = {
  1: ['admissions', 'programmes', 'general'],
  2: ['admissions', 'programmes', 'general'],
  3: ['admissions', 'academic-policy', 'financial-aid', 'programmes', 'general'],
  4: ['admissions', 'academic-policy', 'financial-aid', 'programmes', 'staff-internal', 'general'],
};

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

  const roleNs  = ROLE_NAMESPACES[role] ?? ROLE_NAMESPACES['prospective'];
  const trustNs = TRUST_NAMESPACES[trustLevel] ?? TRUST_NAMESPACES[1];
  const trustNsSet = new Set(trustNs);
  let namespaces   = roleNs.filter((ns) => trustNsSet.has(ns));

  if (namespaceAllowlist && namespaceAllowlist.length > 0) {
    const allowSet = new Set(namespaceAllowlist);
    namespaces     = namespaces.filter((ns) => allowSet.has(ns));
  }

  const [denseVector] = await embedTexts([query]);
  const sparseVector  = buildSparseVector(query);
  const { weightedDense, weightedSparse } = weightVectors(denseVector, sparseVector, RETRIEVAL_CONFIG.alpha);

  // Multi-tenant isolation: always include the user's institution AND GLOBAL_INSTITUTION.
  // Using $in prevents cross-tenant leaks — Institution A never sees Institution B's vectors.
  const resolvedInstitutionId = institutionId ?? GLOBAL_INSTITUTION;
  const institutionFilter = {
    institutionId: { $in: [resolvedInstitutionId, GLOBAL_INSTITUTION] },
  };

  const programmeClause = programme
    ? [{ $or: [{ programme: { $eq: programme } }, { programme: { $exists: false } }] }]
    : [];
  const levelClause = level
    ? [{ $or: [{ level: { $eq: level } }, { level: { $exists: false } }] }]
    : [];

  const pineconeFilter = {
    $and: [
      { roles: { $in: [role] } },
      ...programmeClause,
      ...levelClause,
      institutionFilter,
    ],
  };

  const allMatches: Array<{ score: number; metadata: Record<string, unknown> }> = [];

  const results = await Promise.allSettled(
    namespaces.map((ns) =>
      pineconeIndex.namespace(ns).query({
        vector: weightedDense,
        sparseVector: weightedSparse,
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

  allMatches.sort((a, b) => b.score - a.score);
  const maxScore = allMatches[0].score;

  const seenParents = new Set<string>();
  const retrievalResults: KnowledgeRetrievalResult[] = [];

  for (const match of allMatches) {
    if (retrievalResults.length >= RETRIEVAL_CONFIG.maxResults) break;
    const parentId = match.metadata['parentId'] as string;
    if (seenParents.has(parentId)) continue;
    seenParents.add(parentId);

    const updatedAt = match.metadata['updatedAt'] as string;

    retrievalResults.push({
      chunkId:      match.metadata['chunkId']     as string,
      content:      match.metadata['parentText']  as string,
      source:       match.metadata['source']      as string,
      updatedAt,
      staleWarning: isDaysOld(updatedAt, RETRIEVAL_CONFIG.freshnessThresholdDays)
        ? '⚠️ This information may be outdated. Please verify with the relevant office before acting on it.'
        : null,
    });
  }

  return { found: true, results: retrievalResults, maxScore };
}

export const knowledgeRetrievalTool = createTool({
  id: 'knowledgeRetrievalTool',
  description:
    'Searches the knowledge base for the Faculty of Computing, University of Benin (Uniben). ' +
    'Covers policies, admissions, academic regulations, financial aid, programmes, announcements, and general information. ' +
    'Always call this tool before answering any domain-specific question. ' +
    'Pass the user\'s role so only appropriate information is returned.',
  inputSchema: z.object({
    query: z.string().describe('The user question or topic to retrieve information about.'),
    role: UserRole.describe(
      'The authenticated role of the user. Defaults to prospective student if unknown.'
    ),
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
    trust_level: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .describe('Trust level (1–4) from session context. Hard-gates namespace access.'),
    institution_id: z
      .string()
      .optional()
      .describe(
        'Institution UUID from session context. ' +
        'Scopes retrieval to this institution\'s documents plus globally shared ones. ' +
        'Read from system context field institution_id=<value>. Omit only if not available.'
      ),
    namespace_allowlist: z
      .array(z.string())
      .optional()
      .describe(
        'Explicit namespace allowlist for parent users. ' +
        'Computed server-side from parent_student_links permissions. ' +
        'Pass from the system prompt field parent_namespace_allowlist (comma-separated).'
      ),
  }),
  execute: async (inputData) => {
    const { query, role, programme, level, trust_level, institution_id, namespace_allowlist } = inputData as {
      query: string;
      role: z.infer<typeof UserRole>;
      programme?: string;
      level?: string;
      trust_level?: number;
      institution_id?: string;
      namespace_allowlist?: string[];
    };
    return await retrieveKnowledge({
      query,
      role,
      programme,
      level,
      trustLevel:         trust_level,
      institutionId:      institution_id,
      namespaceAllowlist: namespace_allowlist,
    });
  },
});
