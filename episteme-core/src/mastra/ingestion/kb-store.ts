/**
 * KB Document Registry — LibSQL-backed store for ingestion audit records.
 * Persists metadata for every ingested document: supports listing, deletion,
 * and re-ingestion of text-based documents from the admin dashboard.
 *
 * Uses the same mastra.db file as Mastra core storage.
 */
import { dbClient } from '../db';
import { GLOBAL_INSTITUTION } from './ingest';

export interface KbDocument {
  docId: string;
  fileName: string;
  namespace: string;
  category: string;
  contentType: string;
  faculty: string;
  source: string;
  roles: string[];
  updatedAt: string;
  /** Resolved institution UUID or GLOBAL_INSTITUTION. Always present. */
  institutionId: string;
  vectorsUpserted: number;
  parentChunks: number;
  childChunks: number;
  ingestedAt: string;
  /** Stored for text-based re-ingestion. Null for file-upload docs. */
  markdownContent: string | null;
  plainTextContent: string | null;
  // ── Freshness tracking (URL-sourced documents only) ───────────────────────
  /** The web URL this document was sourced from, if applicable. */
  sourceUrl: string | null;
  /** SHA-256 hex digest of the last-fetched URL content. */
  contentHash: string | null;
  /** ISO timestamp of the last freshness check. */
  lastFetchedAt: string | null;
}

export async function ensureKbTable(): Promise<void> {
  await dbClient.execute(`
    CREATE TABLE IF NOT EXISTS kb_documents (
      doc_id             TEXT PRIMARY KEY,
      file_name          TEXT NOT NULL,
      namespace          TEXT NOT NULL,
      category           TEXT NOT NULL,
      content_type       TEXT NOT NULL,
      faculty            TEXT NOT NULL,
      source             TEXT NOT NULL,
      roles              TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      vectors_upserted   INTEGER NOT NULL,
      parent_chunks      INTEGER NOT NULL,
      child_chunks       INTEGER NOT NULL,
      ingested_at        TEXT NOT NULL,
      markdown_content   TEXT,
      plain_text_content TEXT,
      source_url         TEXT,
      content_hash       TEXT,
      last_fetched_at    TEXT
    )
  `);

  // Idempotent column additions for existing tables.
  // SQLite does not support ALTER TABLE IF NOT EXISTS — catch and ignore duplicate errors.
  const newColumns = [
    'source_url      TEXT',
    'content_hash    TEXT',
    'last_fetched_at TEXT',
    `institution_id  TEXT NOT NULL DEFAULT '${GLOBAL_INSTITUTION}'`,
  ];
  for (const col of newColumns) {
    try {
      await dbClient.execute(`ALTER TABLE kb_documents ADD COLUMN ${col}`);
    } catch {
      // Column already exists — safe to ignore
    }
  }
}

export async function saveDocument(doc: KbDocument): Promise<void> {
  await ensureKbTable();
  // Auto-detect source_url: if `source` looks like a web URL, populate it.
  const detectedSourceUrl = doc.sourceUrl
    ?? (doc.source.startsWith('http://') || doc.source.startsWith('https://')
        ? doc.source
        : null);
  await dbClient.execute({
    sql: `
      INSERT INTO kb_documents (
        doc_id, file_name, namespace, category, content_type, faculty, source,
        roles, updated_at, institution_id, vectors_upserted, parent_chunks, child_chunks,
        ingested_at, markdown_content, plain_text_content,
        source_url, content_hash, last_fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id) DO UPDATE SET
        file_name          = excluded.file_name,
        namespace          = excluded.namespace,
        category           = excluded.category,
        content_type       = excluded.content_type,
        faculty            = excluded.faculty,
        source             = excluded.source,
        roles              = excluded.roles,
        updated_at         = excluded.updated_at,
        institution_id     = excluded.institution_id,
        vectors_upserted   = excluded.vectors_upserted,
        parent_chunks      = excluded.parent_chunks,
        child_chunks       = excluded.child_chunks,
        ingested_at        = excluded.ingested_at,
        markdown_content   = excluded.markdown_content,
        plain_text_content = excluded.plain_text_content,
        source_url         = COALESCE(excluded.source_url, kb_documents.source_url),
        content_hash       = COALESCE(excluded.content_hash, kb_documents.content_hash),
        last_fetched_at    = COALESCE(excluded.last_fetched_at, kb_documents.last_fetched_at)
    `,
    args: [
      doc.docId,
      doc.fileName,
      doc.namespace,
      doc.category,
      doc.contentType,
      doc.faculty,
      doc.source,
      JSON.stringify(doc.roles),
      doc.updatedAt,
      doc.institutionId,
      doc.vectorsUpserted,
      doc.parentChunks,
      doc.childChunks,
      doc.ingestedAt,
      doc.markdownContent ?? null,
      doc.plainTextContent ?? null,
      detectedSourceUrl,
      doc.contentHash ?? null,
      doc.lastFetchedAt ?? null,
    ],
  });
}

/** Updates only the freshness tracking fields — called by the guardian after each check. */
export async function saveFreshnessResult(
  docId: string,
  contentHash: string,
  lastFetchedAt: string,
): Promise<void> {
  await ensureKbTable();
  await dbClient.execute({
    sql: `UPDATE kb_documents SET content_hash = ?, last_fetched_at = ? WHERE doc_id = ?`,
    args: [contentHash, lastFetchedAt, docId],
  });
}

export async function listDocuments(institutionId?: string): Promise<KbDocument[]> {
  await ensureKbTable();
  const result = institutionId
    ? await dbClient.execute({
        sql: `SELECT * FROM kb_documents WHERE institution_id = ? OR institution_id = ? ORDER BY ingested_at DESC`,
        args: [institutionId, GLOBAL_INSTITUTION],
      })
    : await dbClient.execute('SELECT * FROM kb_documents ORDER BY ingested_at DESC');
  return result.rows.map(rowToDocument);
}

export async function getDocument(docId: string): Promise<KbDocument | null> {
  await ensureKbTable();
  const result = await dbClient.execute({
    sql: 'SELECT * FROM kb_documents WHERE doc_id = ?',
    args: [docId],
  });
  if (result.rows.length === 0) return null;
  return rowToDocument(result.rows[0]);
}

export async function deleteDocumentRecord(docId: string): Promise<void> {
  await ensureKbTable();
  await dbClient.execute({
    sql: 'DELETE FROM kb_documents WHERE doc_id = ?',
    args: [docId],
  });
}

function rowToDocument(row: Record<string, unknown>): KbDocument {
  return {
    docId:             row['doc_id'] as string,
    fileName:          row['file_name'] as string,
    namespace:         row['namespace'] as string,
    category:          row['category'] as string,
    contentType:       row['content_type'] as string,
    faculty:           row['faculty'] as string,
    source:            row['source'] as string,
    roles:             JSON.parse(row['roles'] as string) as string[],
    updatedAt:         row['updated_at'] as string,
    institutionId:     (row['institution_id'] as string | null) ?? GLOBAL_INSTITUTION,
    vectorsUpserted:   row['vectors_upserted'] as number,
    parentChunks:      row['parent_chunks'] as number,
    childChunks:       row['child_chunks'] as number,
    ingestedAt:        row['ingested_at'] as string,
    markdownContent:   (row['markdown_content'] as string | null) ?? null,
    plainTextContent:  (row['plain_text_content'] as string | null) ?? null,
    sourceUrl:         (row['source_url'] as string | null) ?? null,
    contentHash:       (row['content_hash'] as string | null) ?? null,
    lastFetchedAt:     (row['last_fetched_at'] as string | null) ?? null,
  };
}
