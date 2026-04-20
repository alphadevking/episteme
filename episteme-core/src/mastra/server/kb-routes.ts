/**
 * Knowledge Base admin API routes — mounted on the Mastra server as Hono handlers.
 *
 * All routes require the x-episteme-admin-key header to match MASTRA_ADMIN_KEY.
 * This is a shared secret for server-to-server calls from episteme-chat.
 *
 * Routes:
 *   GET    /api/kb/documents                       — list all ingested documents
 *   POST   /api/kb/documents                       — ingest a new document
 *   DELETE /api/kb/documents/:docId                — delete from Pinecone + registry
 *   POST   /api/kb/documents/:docId/reingest       — re-ingest a text-based document
 *   POST   /api/kb/documents/:docId/freshness      — update freshness timestamp only
 */
import type { Context } from 'hono';
import { ingestDocument, deleteDocument, GLOBAL_INSTITUTION } from '../ingestion/ingest';
import {
  saveDocument,
  saveFreshnessResult,
  listDocuments,
  getDocument,
  deleteDocumentRecord,
  type KbDocument,
} from '../ingestion/kb-store';
import type { ContentType } from '../ingestion/chunker';

declare const process: { env: Record<string, string | undefined> };

function isAuthorized(c: Context): boolean {
  const adminKey = process.env['MASTRA_ADMIN_KEY'];
  if (!adminKey) return false;
  return c.req.header('x-episteme-admin-key') === adminKey;
}

/** Read institution from the request header — passed by episteme-chat after auth. */
function resolveInstitutionId(c: Context): string | undefined {
  return c.req.header('x-episteme-institution-id') ?? undefined;
}

// ── GET /api/kb/documents ────────────────────────────────────────────────────
export async function listDocumentsHandler(c: Context): Promise<Response> {
  if (!isAuthorized(c)) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const institutionId = resolveInstitutionId(c);
    const docs = await listDocuments(institutionId);
    return c.json({ documents: docs });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
}

// ── POST /api/kb/documents ───────────────────────────────────────────────────
export async function ingestDocumentHandler(c: Context): Promise<Response> {
  if (!isAuthorized(c)) return c.json({ error: 'Unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const {
    docId, fileName, category, namespace, faculty, source, roles,
    updatedAt, contentType, markdownContent, plainTextContent, fileBufferBase64,
  } = body;

  if (!docId || !fileName || !category || !namespace || !faculty || !source || !roles || !updatedAt) {
    return c.json({ error: 'Missing required fields: docId, fileName, category, namespace, faculty, source, roles, updatedAt' }, 400);
  }

  const institutionId = resolveInstitutionId(c);
  const rolesArray = Array.isArray(roles) ? roles as string[] : [roles as string];

  let fileBuffer: Uint8Array | undefined;
  if (fileBufferBase64) {
    const binaryString = atob(fileBufferBase64 as string);
    fileBuffer = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      fileBuffer[i] = binaryString.charCodeAt(i);
    }
  }

  if (!fileBuffer && !markdownContent && !plainTextContent) {
    return c.json({ error: 'One of fileBufferBase64, markdownContent, or plainTextContent must be provided' }, 400);
  }

  // Ghost vector fix: if this docId already exists with a DIFFERENT namespace,
  // delete its vectors from the old namespace before ingesting into the new one.
  // ingestDocument only deletes from its own namespace (idempotency for same-namespace
  // re-ingests), so we must handle cross-namespace cleanup here.
  const existing = await getDocument(docId as string);
  if (existing && existing.namespace !== namespace) {
    await deleteDocument(docId as string, existing.namespace);
  }

  try {
    const audit = await ingestDocument({
      docId: docId as string,
      fileName: fileName as string,
      category: category as string,
      namespace: namespace as string,
      faculty: faculty as string,
      source: source as string,
      roles: rolesArray,
      updatedAt: updatedAt as string,
      institutionId,
      contentType: (contentType as ContentType | undefined) ?? 'general',
      fileBuffer,
      markdownContent: markdownContent as string | undefined,
      plainTextContent: plainTextContent as string | undefined,
    });

    const record = {
      ...audit,
      markdownContent:  (markdownContent  as string | undefined) ?? null,
      plainTextContent: (plainTextContent as string | undefined) ?? null,
      sourceUrl:     null,
      contentHash:   null,
      lastFetchedAt: null,
    } satisfies KbDocument;
    await saveDocument(record);

    return c.json({ success: true, audit });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
}

// ── DELETE /api/kb/documents/:docId ─────────────────────────────────────────
export async function deleteDocumentHandler(c: Context): Promise<Response> {
  if (!isAuthorized(c)) return c.json({ error: 'Unauthorized' }, 401);

  const docId = c.req.param('docId');
  if (!docId) return c.json({ error: 'Missing docId' }, 400);
  const doc = await getDocument(docId);
  if (!doc) return c.json({ error: 'Document not found' }, 404);

  // Delete order: Pinecone first (retry 3×, abort on failure — nothing changed).
  // Then LibSQL. If LibSQL fails after Pinecone succeeds, the agent can no longer
  // retrieve the doc (vectors are gone) so the orphan record is harmless — log it.
  try {
    await deleteDocument(docId, doc.namespace);
  } catch (err) {
    return c.json({ error: `Pinecone deletion failed: ${String(err)}` }, 500);
  }

  try {
    await deleteDocumentRecord(docId);
  } catch (err) {
    // Vectors are gone — agent cannot retrieve this doc anymore.
    // Log the zombie record; a cleanup job can purge it later.
    console.error(`[kb-routes] Pinecone deleted but LibSQL record removal failed for ${docId}:`, err);
  }

  return c.json({ success: true });
}

// ── POST /api/kb/documents/:docId/reingest ───────────────────────────────────
// Accepts an optional body:
//   { markdownContentOverride?: string, contentHash?: string }
// When markdownContentOverride is provided (e.g. from the freshness guardian
// after fetching a URL and detecting a change), it is used instead of the
// stored markdownContent and the new contentHash is persisted.
export async function reingestDocumentHandler(c: Context): Promise<Response> {
  if (!isAuthorized(c)) return c.json({ error: 'Unauthorized' }, 401);

  const docId = c.req.param('docId');
  if (!docId) return c.json({ error: 'Missing docId' }, 400);
  const doc = await getDocument(docId);
  if (!doc) return c.json({ error: 'Document not found' }, 404);

  // Optional override from freshness guardian
  let override: { markdownContentOverride?: string; contentHash?: string } = {};
  try {
    const ct = c.req.header('content-type') ?? '';
    if (ct.includes('application/json')) {
      override = await c.req.json<typeof override>();
    }
  } catch { /* body is optional — ignore parse errors */ }

  const freshMarkdown = override.markdownContentOverride ?? doc.markdownContent;
  const freshText     = doc.plainTextContent;

  if (!freshMarkdown && !freshText) {
    return c.json({
      error: 'Re-ingestion requires the original file to be re-uploaded for binary documents (PDF, DOCX, etc.).',
    }, 422);
  }

  // Institution from header takes precedence; fall back to stored value.
  const institutionId = resolveInstitutionId(c) ?? doc.institutionId;

  try {
    const nowIso = new Date().toISOString();
    const audit = await ingestDocument({
      docId:            doc.docId,
      fileName:         doc.fileName,
      category:         doc.category,
      namespace:        doc.namespace,
      faculty:          doc.faculty,
      source:           doc.source,
      roles:            doc.roles,
      updatedAt:        nowIso,
      institutionId:    institutionId === GLOBAL_INSTITUTION ? undefined : institutionId,
      contentType:      doc.contentType as ContentType,
      markdownContent:  freshMarkdown  ?? undefined,
      plainTextContent: freshText      ?? undefined,
    });

    const updated: KbDocument = {
      ...doc,
      ...audit,
      // Preserve freshness metadata
      sourceUrl:      doc.sourceUrl,
      contentHash:    override.contentHash ?? doc.contentHash,
      lastFetchedAt:  override.contentHash ? nowIso : doc.lastFetchedAt,
    };
    await saveDocument(updated);

    // Also write freshness result if a new hash was provided
    if (override.contentHash) {
      await saveFreshnessResult(docId, override.contentHash, nowIso);
    }

    return c.json({ success: true, audit });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
}

// ── POST /api/kb/documents/:docId/freshness ──────────────────────────────────
// Called by the freshness guardian after a no-change check to update
// last_fetched_at without triggering a full re-ingest.
export async function updateFreshnessHandler(c: Context): Promise<Response> {
  if (!isAuthorized(c)) return c.json({ error: 'Unauthorized' }, 401);

  const docId = c.req.param('docId');
  if (!docId) return c.json({ error: 'Missing docId' }, 400);
  const doc = await getDocument(docId);
  if (!doc) return c.json({ error: 'Document not found' }, 404);

  let body: { contentHash?: string } = {};
  try {
    body = await c.req.json<typeof body>();
  } catch { /* optional */ }

  const hash      = body.contentHash ?? doc.contentHash ?? '';
  const nowIso    = new Date().toISOString();
  await saveFreshnessResult(docId, hash, nowIso);
  return c.json({ success: true, lastFetchedAt: nowIso });
}
