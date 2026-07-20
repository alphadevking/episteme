// episteme-core/src/mastra/server/kb-routes.ts
/**
 * Knowledge Base admin API routes — mounted on the Mastra server as Hono handlers.
 *
 * All routes require the x-episteme-admin-key header to match MASTRA_ADMIN_KEY.
 * This is a shared secret for server-to-server calls from episteme-chat.
 *
 * Routes:
 *   GET    /kb/documents                       — list all ingested documents
 *   POST   /kb/documents                       — ingest a new document
 *   DELETE /kb/documents/:docId                — delete from Pinecone + registry
 *   POST   /kb/documents/:docId/reingest       — re-ingest a text-based document
 *   POST   /kb/documents/:docId/freshness      — update freshness timestamp only
 */
import type { Context } from 'hono';
import { ingestDocument, deleteDocument, GLOBAL_INSTITUTION, type IngestProgressEvent } from '../ingestion/ingest';
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

// ── GET /kb/documents ────────────────────────────────────────────────────
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

// ── POST /kb/documents ───────────────────────────────────────────────────
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
    programme, levels,
  } = body;

  const VALID_ROLES      = new Set(['prospective', 'student', 'parent', 'staff', 'hod']);
  const VALID_LEVELS     = new Set(['100L', '200L', '300L', '400L', '500L', '600L', 'MSc', 'PhD', 'PGD']);
  const VALID_NAMESPACES = new Set(['admissions', 'academic-policy', 'financial-aid', 'programmes', 'staff-internal', 'general']);
  const VALID_CATEGORIES = VALID_NAMESPACES;
  const VALID_CONTENT_TYPES = new Set(['general', 'policy', 'handbook', 'faq', 'announcement', 'catalogue', 'markdown']);

  // ── Required field presence ──────────────────────────────────────────────────
  const missing = (
    [
      ['docId',     docId],
      ['fileName',  fileName],
      ['category',  category],
      ['namespace', namespace],
      ['source',    source],
      ['updatedAt', updatedAt],
    ] as [string, unknown][]
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);

  // roles must be a non-empty array
  const rolesRaw = Array.isArray(roles) ? roles as string[] : (typeof roles === 'string' ? [roles] : []);
  if (rolesRaw.length === 0) missing.push('roles');

  if (missing.length > 0) {
    console.error('[kb-routes] ingestDocumentHandler — missing fields:', missing, {
      docId, fileName, category, namespace, faculty, source, roles, updatedAt, contentType,
    });
    return c.json({ error: `Missing required fields: ${missing.join(', ')}` }, 400);
  }

  // ── Enum validation ──────────────────────────────────────────────────────────
  if (!VALID_NAMESPACES.has(namespace as string))
    return c.json({ error: `Invalid namespace: ${namespace}` }, 400);
  if (!VALID_CATEGORIES.has(category as string))
    return c.json({ error: `Invalid category: ${category}` }, 400);
  if (contentType && !VALID_CONTENT_TYPES.has(contentType as string))
    return c.json({ error: `Invalid contentType: ${contentType}` }, 400);

  const invalidRoles = rolesRaw.filter((r) => !VALID_ROLES.has(r));
  if (invalidRoles.length > 0)
    return c.json({ error: `Invalid roles: ${invalidRoles.join(', ')}` }, 400);

  const levelsRaw = Array.isArray(levels)
    ? (levels as string[]).map((l) => l.trim()).filter(Boolean)
    : (typeof levels === 'string' && levels.trim() ? [levels.trim()] : []);
  const invalidLevels = levelsRaw.filter((l) => !VALID_LEVELS.has(l));
  if (invalidLevels.length > 0)
    return c.json({ error: `Invalid levels: ${invalidLevels.join(', ')}` }, 400);

  // ── Date validation ──────────────────────────────────────────────────────────
  const updatedAtDate = new Date(updatedAt as string);
  if (isNaN(updatedAtDate.getTime()))
    return c.json({ error: 'Invalid updatedAt: must be a valid date string' }, 400);

  // faculty is optional — institution-wide docs have no faculty scope
  const resolvedFaculty = (faculty as string | undefined)?.trim() || 'general';

  const institutionId = resolveInstitutionId(c);

  // ── Base64 decode ────────────────────────────────────────────────────────────
  let fileBuffer: Uint8Array | undefined;
  if (fileBufferBase64) {
    try {
      const binaryString = atob(fileBufferBase64 as string);
      fileBuffer = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        fileBuffer[i] = binaryString.charCodeAt(i);
      }
    } catch {
      return c.json({ error: 'Invalid fileBufferBase64: not valid base64' }, 400);
    }
  }

  if (!fileBuffer && !markdownContent && !plainTextContent) {
    return c.json({ error: 'One of fileBufferBase64, markdownContent, or plainTextContent must be provided' }, 400);
  }

  // All validation passed — stream progress via SSE so the client never times out
  // and can display each pipeline step in real-time.
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function emit(event: string, data: unknown) {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch { /* stream already closed */ }
      }

      emit('progress', { step: 'extracting' });

      try {
        // Ghost vector fix: cross-namespace cleanup before ingestion.
        const existing = await getDocument(docId as string);
        if (existing && existing.namespace !== namespace) {
          await deleteDocument(docId as string, existing.namespace);
        }

        const audit = await ingestDocument({
          docId:       docId as string,
          fileName:    fileName as string,
          category:    category as string,
          namespace:   namespace as string,
          faculty:     resolvedFaculty,
          source:      source as string,
          roles:       rolesRaw,
          updatedAt:   updatedAtDate.toISOString(),
          institutionId,
          contentType: (contentType as ContentType | undefined) ?? 'general',
          programme:   (programme as string | undefined) || undefined,
          levels:      levelsRaw.length > 0 ? levelsRaw : undefined,
          fileBuffer,
          markdownContent:  markdownContent  as string | undefined,
          plainTextContent: plainTextContent as string | undefined,
          onProgress:  (p: IngestProgressEvent) => emit('progress', p),
        });

        emit('progress', { step: 'saving' });

        const record: KbDocument = {
          ...audit,
          markdownContent:  (markdownContent  as string | undefined) ?? null,
          plainTextContent: (plainTextContent as string | undefined) ?? null,
          sourceUrl:     null,
          contentHash:   null,
          lastFetchedAt: null,
        };
        await saveDocument(record);

        emit('done', { success: true, audit });
      } catch (err) {
        emit('error', { error: String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  });
}

// ── DELETE /kb/documents/:docId ─────────────────────────────────────────
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

// ── POST /kb/documents/:docId/reingest ───────────────────────────────────
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

  // Stream via SSE — mirrors ingestDocumentHandler so large docs don't hit gateway timeouts.
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function emit(event: string, data: unknown) {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch { /* stream already closed */ }
      }

      emit('progress', { step: 'extracting' });

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
          programme:        doc.programme ?? undefined,
          levels:           doc.levels,
          markdownContent:  freshMarkdown   ?? undefined,
          plainTextContent: freshText       ?? undefined,
          onProgress:       (p: IngestProgressEvent) => emit('progress', p),
        });

        emit('progress', { step: 'saving' });

        const updated: KbDocument = {
          ...doc,
          ...audit,
          sourceUrl:     doc.sourceUrl,
          contentHash:   override.contentHash ?? doc.contentHash,
          lastFetchedAt: override.contentHash ? nowIso : doc.lastFetchedAt,
        };
        await saveDocument(updated);

        if (override.contentHash) {
          await saveFreshnessResult(docId, override.contentHash, nowIso);
        }

        emit('done', { success: true, audit });
      } catch (err) {
        emit('error', { error: String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  });
}

// ── POST /kb/documents/:docId/freshness ──────────────────────────────────
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
