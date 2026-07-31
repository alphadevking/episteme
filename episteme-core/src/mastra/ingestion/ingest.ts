import { Pinecone, type RecordMetadata } from '@pinecone-database/pinecone';
import { type ParentChunk, type ChildChunk, type ContentType } from './chunker';
import { embedTexts, buildSparseVector } from './embedder';
import { INGEST_CONFIG } from '../config';
// IngestProgressEvent is imported (used in commitDocument's signature below) AND
// re-exported. A bare re-export does not bring a name into local scope, so the
// two are not redundant.
import {
  prepareDocument,
  type IngestOptions,
  type PreparedDocument,
  type IngestProgressEvent,
} from './prepare';

/**
 * Phase 1 lives in ./prepare — a module that imports neither Pinecone, the
 * embedder, nor the registry, so it structurally cannot write. Re-exported here
 * because existing importers (kb-routes, kb-store) expect these names from this
 * module, and so that `prepare` and `commit` read as one pipeline.
 */
export {
  prepareDocument,
  summarizePrepared,
  type IngestOptions,
  type IngestProgressEvent,
  type PreparedDocument,
  type DryRunReport,
} from './prepare';


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

export interface IngestAuditResult {
  docId: string;
  fileName: string;
  namespace: string;
  category: string;
  contentType: ContentType;
  faculty: string;
  source: string;
  roles: string[];
  /** Null for a genuinely undated source. See IngestOptions.updatedAt. */
  updatedAt: string | null;
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
 * Phase 2 — embed and write. This is the only phase that mutates anything.
 *
 * Ordering note: the delete of the previous version now happens AFTER embedding
 * succeeds, not before extraction. Previously it ran before chunking and
 * embedding, so a zero-chunk result or a transient embedding failure destroyed
 * the existing vectors with nothing to replace them — a re-ingest during a
 * provider outage silently emptied a document. The narrowest window we can have
 * is delete-then-upsert, which is what this does.
 */
export async function commitDocument(
  prepared: PreparedDocument,
  onProgress?: (event: IngestProgressEvent) => void,
): Promise<IngestAuditResult> {
  const {
    docId, fileName, namespace, category, contentType, faculty, source, roles,
    updatedAt, institutionId, programme, levels, ingestedAt, parents, children,
  } = prepared;

  // 1. Embed child chunks (dense vectors via Mastra model router, retries built-in)
  const texts = children.map((c: ChildChunk) => c.text);
  onProgress?.({ step: 'embedding', parents: parents.length, children: children.length });
  const denseVectors = await embedTexts(texts);

  // 2. Parent lookup map — O(1)
  const parentMap = new Map<string, ParentChunk>(
    parents.map((p: ParentChunk) => [p.parentId, p])
  );

  // 3. Build Pinecone records with dense + sparse vectors
  const records = children.map((child: ChildChunk, i: number) => {
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
        // Omitted entirely when undated — Pinecone metadata cannot hold null,
        // and an absent key is exactly how retrieval detects "no content date".
        ...(updatedAt ? { updatedAt } : {}),
        // Audit-only: when we loaded this doc. Staleness uses `updatedAt`
        // (content date), NOT this — see the const definition.
        ingestedAt,
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

  // 4. Idempotency — remove the previous version only now that we have vectors
  //    ready to replace it. See the ordering note above.
  await deleteDocument(docId, namespace);

  // 5. Upsert to Pinecone — all batches in parallel, each with retry
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
    programme,
    levels,
    vectorsUpserted: records.length,
    parentChunks: parents.length,
    childChunks: children.length,
    ingestedAt,
  };
}

/**
 * Full ingestion pipeline:
 * input → extract text → hierarchical chunk (MDocument) → embed → sparse → upsert to Pinecone
 *
 * Idempotent: replaces any existing vectors for the docId.
 * Retries Pinecone upsert batches on transient failures with exponential backoff.
 * Returns a structured audit result — caller is responsible for persisting it.
 *
 * Supports any document form: PDF, DOCX, Markdown, plain text,
 * announcements, FAQs, course catalogues, handbooks.
 */
export async function ingestDocument(options: IngestOptions): Promise<IngestAuditResult> {
  const prepared = await prepareDocument(options);
  return commitDocument(prepared, options.onProgress);
}


/**
 * Fields that can be patched on an already-ingested document without re-extracting
 * or re-embedding it. All are pure Pinecone metadata — changing them only affects
 * how the document is filtered/tagged during retrieval, not its chunked content.
 *
 * Deliberately excludes `namespace` (a Pinecone partition, not metadata — moving a
 * document between namespaces means deleting and re-upserting every vector, not a
 * patch) and `institutionId` (multi-tenant isolation — changing it is a security-
 * relevant operation that belongs in the full ingest/reingest path, not a quick edit).
 */
export interface DocumentScopePatch {
  roles?: string[];
  levels?: string[];
  programme?: string;
  category?: string;
  contentType?: ContentType;
  /** ISO content date — the document's own editorial date, which drives the
   *  freshness/staleness signal in retrieval. Safe to patch (a scalar the merge
   *  overwrites), so an admin can correct it without re-ingesting.
   *
   *  NOTE: a document can be patched from undated to dated, but NOT back —
   *  Pinecone's metadata update merges keys and cannot remove one, the same
   *  limitation documented on patchDocumentMetadata for levels/programme.
   *  Returning a document to undated requires a full re-ingest. */
  updatedAt?: string;
}

/**
 * Patch metadata on every existing vector for a docId, in place — no re-extraction,
 * re-chunking, or re-embedding. Uses Pinecone's filter-based update (matches every
 * vector with this docId in the namespace) rather than fetch-then-loop-update.
 *
 * IMPORTANT LIMITATION: Pinecone's metadata update *merges* the given keys into each
 * vector's existing metadata — it cannot *remove* a key. That means a document once
 * scoped to specific `levels`/`programme` can be re-scoped to a different non-empty
 * set here, but can never be widened back to "all levels" / "all programmes" via
 * patch (retrieval-gate.ts treats a present-but-empty array as "matches nothing",
 * not "unscoped" — see buildRetrievalFilter's `$exists: false` branch). Clearing a
 * scope back to unscoped requires a full re-ingest, which deletes and rebuilds the
 * vectors from scratch.
 */
export async function patchDocumentMetadata(
  docId: string,
  namespace: string,
  patch: DocumentScopePatch,
): Promise<void> {
  // Partial<RecordMetadata>, not Record<string, unknown>: Pinecone metadata
  // values are constrained to string | number | boolean | string[]. Typing this
  // loosely let a value Pinecone rejects at runtime pass the compiler.
  const metadata: Partial<RecordMetadata> = {};
  if (patch.roles       !== undefined) metadata.roles       = patch.roles;
  if (patch.levels      !== undefined) metadata.levels      = patch.levels;
  if (patch.programme   !== undefined) metadata.programme   = patch.programme;
  if (patch.category    !== undefined) metadata.category    = patch.category;
  if (patch.contentType !== undefined) metadata.contentType = patch.contentType;
  if (patch.updatedAt   !== undefined) metadata.updatedAt   = patch.updatedAt;

  if (Object.keys(metadata).length === 0) return;

  const index = pineconeIndex.namespace(namespace);
  await withRetry(() =>
    index.update({ filter: { docId: { $eq: docId } }, metadata })
  );
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
