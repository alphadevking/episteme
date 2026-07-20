import { Pinecone } from '@pinecone-database/pinecone';
import { processDocument, processMarkdown, processPlainText, elementsToText, buildPageOffsetMap, type PageOffsetEntry } from './document-processor';
import { buildHierarchicalChunks, type ParentChunk, type ChildChunk, type ContentType } from './chunker';
import { embedTexts, buildSparseVector } from './embedder';
import { INGEST_CONFIG } from '../config';

declare const process: { env: Record<string, string | undefined> };

/**
 * Sentinel value for institution-agnostic (globally shared) documents.
 * Every vector is tagged with either a real institution UUID or this sentinel,
 * so retrieval can always filter with { $in: [institutionId, GLOBAL_INSTITUTION] }
 * without silent cross-tenant leaks.
 *
 * Defined in security/retrieval-gate.ts — the ingestion tag and the retrieval
 * filter must never drift apart, so they read the same constant. Re-exported
 * here because existing importers (kb-routes) expect it from this module.
 */
export { GLOBAL_INSTITUTION } from '../security/retrieval-gate';

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

const pinecone = new Pinecone({ apiKey: getEnv('PINECONE_API_KEY') });
// Module-level singleton — avoids reconstructing the client on every call
const pineconeIndex = pinecone.index({ name: getEnv('PINECONE_INDEX') });

/**
 * Progress events emitted during ingestion — forwarded as SSE to the admin dashboard.
 * Each event fires immediately before the corresponding step begins so the UI
 * updates in real-time rather than after the step completes.
 */
export type IngestProgressEvent =
  | { step: 'chunking' }
  | { step: 'embedding'; parents: number; children: number }
  | { step: 'upserting'; chunks: number };

export interface IngestOptions {
  /** Raw file bytes — for PDF, DOCX, HTML, scanned images */
  fileBuffer?: Uint8Array;
  /** Pre-converted Markdown string */
  markdownContent?: string;
  /** Plain text string — for announcements, emails, general info */
  plainTextContent?: string;
  /** Optional progress callback — used by the SSE streaming handler */
  onProgress?: (event: IngestProgressEvent) => void;
  /** Original file name e.g. "admissions-policy.pdf" */
  fileName: string;
  docId: string;
  /** Domain category: 'admissions' | 'academic-policy' | 'financial-aid' | 'programmes' | 'staff-internal' | 'general' */
  category: string;
  /** Pinecone namespace to upsert into */
  namespace: string;
  /** Faculty scope: 'computing' | future faculties */
  faculty: string;
  /** Source URL or descriptive reference */
  source: string;
  /** Roles that may access this document */
  roles: string[];
  /** ISO date string of last document update */
  updatedAt: string;
  /**
   * Institution UUID for multi-tenant isolation.
   * Omit only for truly global documents shared across all institutions —
   * they will be tagged with GLOBAL_INSTITUTION and visible to every tenant.
   */
  institutionId?: string;
  /**
   * Optional programme scope e.g. "Computer Science", "Software Engineering".
   * Leave unset for faculty-wide or general documents — they are returned for all programmes.
   */
  programme?: string;
  /**
   * Optional academic level scope e.g. ["300L"], ["MSc", "PhD", "PGD"].
   * A document may belong to several levels (e.g. a shared postgraduate handbook).
   * Leave unset/empty for documents that apply to all levels — they are returned
   * regardless of student level.
   */
  levels?: string[];
  /** Drives chunking strategy — defaults to 'general' */
  contentType?: ContentType;
}

export interface IngestAuditResult {
  docId: string;
  fileName: string;
  namespace: string;
  category: string;
  contentType: ContentType;
  faculty: string;
  source: string;
  roles: string[];
  updatedAt: string;
  /** The resolved institution UUID, or GLOBAL_INSTITUTION for shared docs. */
  institutionId: string;
  programme: string | null;
  levels: string[];
  vectorsUpserted: number;
  parentChunks: number;
  childChunks: number;
  ingestedAt: string; // ISO timestamp
}

/**
 * Retry a Pinecone operation with exponential backoff.
 * Handles transient network errors and rate limits without failing the ingestion.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = INGEST_CONFIG.retryAttempts,
  baseDelayMs = INGEST_CONFIG.retryBaseDelayMs,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1))
        );
      }
    }
  }
  throw lastError;
}

/**
 * Full ingestion pipeline:
 * input → extract text → hierarchical chunk (MDocument) → embed → sparse → upsert to Pinecone
 *
 * Idempotent: deletes existing vectors for the docId before upserting.
 * Retries Pinecone upsert batches on transient failures with exponential backoff.
 * Returns a structured audit result — caller is responsible for persisting it.
 *
 * Supports any document form: PDF, DOCX, Markdown, plain text,
 * announcements, FAQs, course catalogues, handbooks.
 */
export async function ingestDocument(options: IngestOptions): Promise<IngestAuditResult> {
  const {
    fileBuffer, markdownContent, plainTextContent,
    fileName, docId, category, namespace,
    faculty, source, roles, updatedAt, programme, levels,
    contentType = 'general',
    onProgress,
  } = options;

  // Resolve institution — always a concrete value so filters never silently miss.
  const institutionId = options.institutionId ?? GLOBAL_INSTITUTION;

  // 1. Extract full text from input
  let fullText: string;
  let pageOffsetMap: PageOffsetEntry[] = [];

  if (markdownContent) {
    fullText = elementsToText(processMarkdown(markdownContent, category));
  } else if (plainTextContent) {
    fullText = elementsToText(processPlainText(plainTextContent, category));
  } else if (fileBuffer) {
    const elements = await processDocument(fileBuffer, fileName, category);
    pageOffsetMap = buildPageOffsetMap(elements);
    fullText = elementsToText(elements);
  } else {
    throw new Error('One of fileBuffer, markdownContent, or plainTextContent must be provided');
  }

  if (!fullText.trim()) {
    throw new Error(`No content extracted from ${fileName}`);
  }

  // 2. Idempotency — remove existing vectors for this docId before re-ingesting
  await deleteDocument(docId, namespace);

  // 3. Build hierarchical parent/child chunks via MDocument
  onProgress?.({ step: 'chunking' });
  const parents = await buildHierarchicalChunks(fullText, docId, category, contentType, pageOffsetMap);
  const allChildren = parents.flatMap((p: ParentChunk) => p.children);

  if (allChildren.length === 0) {
    throw new Error(`No chunks produced from ${fileName}`);
  }

  // 4. Embed child chunks (dense vectors via Mastra model router, retries built-in)
  const texts = allChildren.map((c: ChildChunk) => c.text);
  onProgress?.({ step: 'embedding', parents: parents.length, children: allChildren.length });
  const denseVectors = await embedTexts(texts);

  // 5. Build parent lookup map — O(1)
  const parentMap = new Map<string, ParentChunk>(
    parents.map((p: ParentChunk) => [p.parentId, p])
  );

  // 6. Build Pinecone records with dense + sparse vectors
  const records = allChildren.map((child: ChildChunk, i: number) => {
    const parent = parentMap.get(child.parentId)!;
    return {
      id: child.chunkId,
      values: denseVectors[i],
      sparseValues: buildSparseVector(child.text),
      metadata: {
        chunkId: child.chunkId,
        parentId: child.parentId,
        parentText: parent.text,
        text: child.text,
        chunkIndex: child.chunkIndex,
        docId,
        category,
        contentType,
        faculty,
        source,
        roles,
        updatedAt,
        // Always present — either a real institution UUID or GLOBAL_INSTITUTION.
        // Retrieval filters with { $in: [userInstitutionId, GLOBAL_INSTITUTION] }
        // so global docs are visible to all tenants without leaking tenant-specific ones.
        institutionId,
        pageNumber: child.pageNumber ?? -1,
        // Only set for programme-specific documents.
        // Omitted for faculty-wide docs so they match all programme filter queries.
        ...(programme ? { programme } : {}),
        // Only set for level-specific documents (e.g. "Final Year Project handbook").
        // Omitted for docs that apply to all levels — they match all level filter queries.
        ...(levels && levels.length > 0 ? { levels } : {}),
      },
    };
  });

  // 7. Upsert to Pinecone — all batches in parallel, each with retry
  onProgress?.({ step: 'upserting', chunks: texts.length });
  const index = pineconeIndex.namespace(namespace);
  const BATCH_SIZE = INGEST_CONFIG.upsertBatchSize;

  await Promise.all(
    Array.from({ length: Math.ceil(records.length / BATCH_SIZE) }, (_, i) => {
      const batch = records.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
      return withRetry(() => index.upsert({ records: batch }));
    })
  );

  return {
    docId,
    fileName,
    namespace,
    category,
    contentType,
    faculty,
    source,
    roles,
    updatedAt,
    institutionId,
    programme: programme ?? null,
    levels:    levels    ?? [],
    vectorsUpserted: records.length,
    parentChunks: parents.length,
    childChunks: allChildren.length,
    ingestedAt: new Date().toISOString(),
  };
}

/**
 * Delete all vectors for a given docId from a namespace.
 * Called automatically before re-ingestion (idempotency).
 * Also called directly by the admin dashboard on document removal.
 *
 * 404 is treated as success — the namespace or vectors don't exist yet, nothing to delete.
 */
export async function deleteDocument(docId: string, namespace: string): Promise<void> {
  const index = pineconeIndex.namespace(namespace);
  try {
    await withRetry(() => index.deleteMany({ filter: { docId: { $eq: docId } } }));
  } catch (err) {
    if (String(err).includes('404')) return;
    throw err;
  }
}
