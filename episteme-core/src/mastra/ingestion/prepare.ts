// episteme-core/src/mastra/ingestion/prepare.ts
/**
 * Phase 1 of ingestion — extract and chunk. **Nothing here writes.**
 *
 * Deliberately isolated from ingest.ts, which constructs a Pinecone client at
 * import scope and pulls in the embedder (both throw without credentials). Two
 * things fall out of that separation:
 *
 *   1. The no-write guarantee is structural, not a convention. This module does
 *      not import Pinecone, the embedder, or the registry, so prepareDocument
 *      *cannot* write — there is nothing here to write with. The dry-run route
 *      depends on exactly that.
 *   2. It is unit-testable with no credentials and no network, for the markdown
 *      and plain-text paths. Same rationale as security/retrieval-gate.ts.
 *
 * Extraction of binary/HTML input still calls Unstructured — that is a read,
 * but it does consume API quota, one call per document. See the note on
 * prepareDocument before adding a preview to a hot path.
 */
import {
  processDocument,
  processMarkdown,
  processPlainText,
  elementsToText,
  buildPageOffsetMap,
  type PageOffsetEntry,
} from './document-processor';
import {
  buildHierarchicalChunks,
  type ParentChunk,
  type ChildChunk,
  type ContentType,
} from './chunker';
import { GLOBAL_INSTITUTION } from '../security/retrieval-gate';

/**
 * Progress events emitted during ingestion — forwarded as SSE to the admin
 * dashboard. Each fires immediately before its step begins so the UI updates in
 * real time rather than after the step completes.
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
  /** Domain category: 'admissions' | 'academic-policy' | ... */
  category: string;
  /** Pinecone namespace to upsert into */
  namespace: string;
  /** Faculty scope: 'computing' | future faculties */
  faculty: string;
  /** Source URL or descriptive reference */
  source: string;
  /** Roles that may access this document */
  roles: string[];
  /**
   * ISO date of the document's own content — when it was written or last
   * revised, NOT when it was loaded. Drives the staleness signal in retrieval.
   *
   * `null` means GENUINELY UNDATED: a scraped web page that shows no date
   * anywhere. This must be a deliberate declaration, never a default for a
   * caller that simply didn't supply one — see kb-routes, which rejects an
   * absent `updatedAt` while accepting an explicit null. Stamping "today" on an
   * undated page is the failure this exists to avoid: it marks the document
   * permanently fresh and turns the staleness warning into a lie.
   *
   * An undated document is NOT treated as stale. Unknown age is not old age —
   * it is simply unknown, and retrieval says so rather than guessing either way.
   */
  updatedAt: string | null;
  /**
   * Institution UUID for multi-tenant isolation. Omit only for truly global
   * documents shared across all institutions — they are tagged with
   * GLOBAL_INSTITUTION and visible to every tenant.
   */
  institutionId?: string;
  /** Optional programme scope. Unset = returned for all programmes. */
  programme?: string;
  /** Optional level scope e.g. ["MSc","PhD"]. Unset = all levels. */
  levels?: string[];
  /** Drives chunking strategy — defaults to 'general' */
  contentType?: ContentType;
}

/**
 * Everything the pipeline derives from an input document, with no side effects.
 * Produced here, consumed by commitDocument in ingest.ts.
 */
export interface PreparedDocument {
  docId: string;
  fileName: string;
  namespace: string;
  category: string;
  contentType: ContentType;
  faculty: string;
  source: string;
  roles: string[];
  /** Null for a genuinely undated source. */
  updatedAt: string | null;
  institutionId: string;
  programme: string | null;
  levels: string[];
  ingestedAt: string;
  parents: ParentChunk[];
  children: ChildChunk[];
  /** Characters of extracted text, before chunking. Dry-run diagnostics. */
  textLength: number;
}

/**
 * Extract and chunk an input document. Performs no writes.
 *
 * Costs one Unstructured API call for `fileBuffer` input (PDF, DOCX, HTML);
 * the markdown and plain-text paths are entirely local.
 */
export async function prepareDocument(options: IngestOptions): Promise<PreparedDocument> {
  const {
    fileBuffer, markdownContent, plainTextContent,
    fileName, docId, category, namespace,
    faculty, source, roles, updatedAt, programme, levels,
    contentType = 'general',
    onProgress,
  } = options;

  // Resolve institution — always a concrete value so filters never silently miss.
  const institutionId = options.institutionId ?? GLOBAL_INSTITUTION;

  // Audit timestamp: when this document was loaded into the KB. Auto-stamped.
  // NOT the freshness signal — staleness is measured from the content's own
  // date (`updatedAt`) in knowledge-retrieval-tool.ts, because a freshly-loaded
  // document can still contain a stale fact (a former VC's name in a re-uploaded
  // 2022 handbook). Kept in metadata for auditing/debugging.
  const ingestedAt = new Date().toISOString();

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

  // 2. Build hierarchical parent/child chunks via MDocument
  onProgress?.({ step: 'chunking' });
  const parents = await buildHierarchicalChunks(fullText, docId, category, contentType, pageOffsetMap);
  const children = parents.flatMap((p: ParentChunk) => p.children);

  if (children.length === 0) {
    throw new Error(`No chunks produced from ${fileName}`);
  }

  return {
    docId, fileName, namespace, category, contentType, faculty, source, roles,
    updatedAt, institutionId,
    programme: programme ?? null,
    levels:    levels    ?? [],
    ingestedAt,
    parents,
    children,
    textLength: fullText.length,
  };
}

/** What a dry run reports: exactly what commitDocument would have written. */
export interface DryRunReport {
  docId: string;
  fileName: string;
  namespace: string;
  category: string;
  contentType: ContentType;
  roles: string[];
  updatedAt: string | null;
  institutionId: string;
  programme: string | null;
  levels: string[];
  /** Characters of text extracted before chunking. */
  textLength: number;
  parentChunks: number;
  childChunks: number;
  /** Vectors that WOULD be upserted. Nothing was written. */
  vectorsWouldUpsert: number;
  /**
   * The parent chunks, verbatim and in order — the units retrieval hands the
   * model. Bounded by a character budget; see `chunksTruncated`.
   */
  chunks: DryRunChunk[];
  /**
   * True when the budget stopped the list short of every parent. The reviewer
   * is then looking at part of the document, and must be told so.
   */
  chunksTruncated: boolean;
}

/** One reviewable unit of the prepared document. */
export interface DryRunChunk {
  index: number;
  /** Characters in the chunk. Equal to `text.length` — nothing here is elided. */
  length: number;
  /** Exactly what would be stored. Never truncated: see summarizePrepared. */
  text: string;
  /** Source page, when the extractor knew one (PDFs). */
  pageNumber: number | null;
  /** Children derived from this parent — one embedded vector each. */
  childCount: number;
}

/**
 * How much chunk text one report may carry, in characters.
 *
 * Generous on purpose. A preview exists so a person can read what is about to
 * enter the knowledge base, and a preview that shows three paragraphs of a
 * twenty-page policy cannot support that decision — it can only support
 * "extraction produced something". Harvested web pages run tens of KB; this
 * covers them whole and still bounds the pathological PDF.
 */
const CHUNK_TEXT_BUDGET = 500_000;

/**
 * Summarise a prepared document without writing anything.
 *
 * Reports PARENT chunks, not children: a parent is what retrieval hands to the
 * model as context, so it is the unit a reviewer needs to judge.
 *
 * Chunk text is returned WHOLE. An earlier version truncated each chunk to 600
 * characters, which made the report cheap to send and impossible to review
 * against — the reviewer could not tell a clean extraction from one that had
 * swallowed a navigation menu 700 characters in. When the budget runs out this
 * drops whole chunks and says so, rather than silently shortening every chunk:
 * a partial list of complete chunks is honest, a complete list of partial
 * chunks is not.
 */
export function summarizePrepared(
  prepared: PreparedDocument,
  budget = CHUNK_TEXT_BUDGET,
): DryRunReport {
  const chunks: DryRunChunk[] = [];
  let spent = 0;

  for (const [index, parent] of prepared.parents.entries()) {
    // Always include the first chunk, however long — a report with no content
    // at all is worse than one over budget by a single chunk.
    if (spent + parent.text.length > budget && chunks.length > 0) break;
    chunks.push({
      index,
      length: parent.text.length,
      text: parent.text,
      pageNumber: parent.pageNumber,
      childCount: parent.children.length,
    });
    spent += parent.text.length;
  }

  return {
    docId: prepared.docId,
    fileName: prepared.fileName,
    namespace: prepared.namespace,
    category: prepared.category,
    contentType: prepared.contentType,
    roles: prepared.roles,
    updatedAt: prepared.updatedAt,
    institutionId: prepared.institutionId,
    programme: prepared.programme,
    levels: prepared.levels,
    textLength: prepared.textLength,
    parentChunks: prepared.parents.length,
    childChunks: prepared.children.length,
    vectorsWouldUpsert: prepared.children.length,
    chunks,
    chunksTruncated: chunks.length < prepared.parents.length,
  };
}
