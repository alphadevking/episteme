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
// NOT `import type { Context } from 'hono'`. @mastra/core vendors its own copy
// of hono's type declarations (dist/_types/hono/), and `apiRoutes[].handler` is
// typed against *those*. Importing from the real hono package gives a
// structurally different `HonoRequest`, so every handler fails to assign with a
// baffling "Type 'HonoRequest' is missing properties from type 'HonoRequest'".
// ContextWithMastra comes from the same declarations the route table expects —
// which is why chat-security.ts already uses it.
import type { ContextWithMastra } from '@mastra/core/server';
import {
  ingestDocument,
  prepareDocument,
  summarizePrepared,
  deleteDocument,
  patchDocumentMetadata,
  GLOBAL_INSTITUTION,
  type IngestProgressEvent,
  type DocumentScopePatch,
} from '../ingestion/ingest';
import {
  saveDocument,
  saveFreshnessResult,
  listDocuments,
  getDocument,
  deleteDocumentRecord,
  type KbDocument,
} from '../ingestion/kb-store';
import type { ContentType } from '../ingestion/chunker';
import { fetchUnibenPage } from '../ingestion/url-fetcher';


const VALID_ROLES         = new Set(['prospective', 'student', 'parent', 'staff', 'hod']);
const VALID_LEVELS        = new Set(['100L', '200L', '300L', '400L', '500L', '600L', 'MSc', 'PhD', 'PGD']);
// Institutional namespaces — the only ones an institution admin may ingest into
// via the dashboard. Platform namespaces are deliberately absent: that corpus is
// Markdown in src/content/platform, read from disk and never stored in Pinecone,
// so there is nothing here for a tenant to write into even by accident.
const VALID_NAMESPACES    = new Set(['admissions', 'academic-policy', 'financial-aid', 'programmes', 'staff-internal', 'general']);
const VALID_CATEGORIES    = VALID_NAMESPACES;
const VALID_CONTENT_TYPES = new Set(['general', 'policy', 'handbook', 'faq', 'announcement', 'catalogue', 'markdown']);

function isAuthorized(c: ContextWithMastra): boolean {
  const adminKey = process.env['MASTRA_ADMIN_KEY'];
  if (!adminKey) return false;
  return c.req.header('x-episteme-admin-key') === adminKey;
}

/** Read institution from the request header — passed by episteme-chat after auth. */
function resolveInstitutionId(c: ContextWithMastra): string | undefined {
  return c.req.header('x-episteme-institution-id') ?? undefined;
}

// ── POST /kb/fetch ───────────────────────────────────────────────────────
/**
 * Fetch a uniben.edu page's cleaned HTML without ingesting it.
 *
 * Exists for the records half of the harvest: the extractor runs in
 * episteme-chat (which owns Supabase) but must not hold the Cloudflare proxy
 * secret or a second copy of the host allowlist — duplicating a security
 * boundary is how the two copies drift. Core stays the only holder of both.
 *
 * SECURITY: this grants strictly LESS than the route below it. POST
 * /kb/documents with `sourceUrl` already performs exactly this fetch behind
 * exactly this admin key; the only difference is that it ingests the result
 * instead of returning it. Same auth, same allowlist (enforced by
 * assertIngestableUrl here and again by the Worker), same GET-only read proxy,
 * same 15s timeout and 5MB cap. No new capability, only a narrower shape of an
 * existing one.
 */
export async function fetchPageHandler(c: ContextWithMastra): Promise<Response> {
  if (!isAuthorized(c)) return c.json({ error: 'Unauthorized' }, 401);

  let body: { url?: unknown };
  try {
    body = await c.req.json<{ url?: unknown }>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const url = body.url;
  if (typeof url !== 'string' || !url.trim()) {
    return c.json({ error: 'Missing required field: url' }, 400);
  }

  try {
    // Throws with a user-facing message on a disallowed host or bad scheme.
    const page = await fetchUnibenPage(url);
    return c.json({ url: page.url, contentHash: page.contentHash, html: page.html });
  } catch (err) {
    // 400 rather than 500: every failure mode here (blocked host, bad URL,
    // timeout, oversized page, empty body) is about the request, not the server.
    return c.json({ error: (err as Error).message }, 400);
  }
}

// ── GET /kb/documents ────────────────────────────────────────────────────
export async function listDocumentsHandler(c: ContextWithMastra): Promise<Response> {
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
export async function ingestDocumentHandler(c: ContextWithMastra): Promise<Response> {
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
    programme, levels, sourceUrl, dryRun,
  } = body;

  // Preview mode. Runs the REAL pipeline (fetch -> clean -> extract -> chunk)
  // and stops before anything is written, so what the reviewer sees is what
  // would land — not the output of a parallel preview path that could drift.
  // Strict `=== true`: any other value, including a truthy string, is a normal
  // ingest. A preview must be asked for explicitly, never inferred.
  const isDryRun = dryRun === true;

  // ── Required field presence ──────────────────────────────────────────────────
  const missing = (
    [
      ['docId',     docId],
      ['fileName',  fileName],
      ['category',  category],
      ['namespace', namespace],
      ['source',    source],
    ] as [string, unknown][]
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);

  // `updatedAt` is required to be PRESENT but may be explicitly null, meaning
  // the source carries no date at all. Absent is an error rather than a silent
  // "undated": an admin who forgets the content date must be told, while the
  // harvest can declare undated deliberately. Undated must never be a default.
  if (updatedAt === undefined) missing.push('updatedAt (send null for an undated source)');

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
  // null → undated. Anything else must parse; a junk date is rejected rather
  // than quietly degraded to undated, which would hide a caller's bug.
  let resolvedUpdatedAt: string | null = null;
  if (updatedAt !== null) {
    const updatedAtDate = new Date(updatedAt as string);
    if (isNaN(updatedAtDate.getTime()))
      return c.json({ error: 'Invalid updatedAt: must be a valid date string, or null for an undated source' }, 400);
    resolvedUpdatedAt = updatedAtDate.toISOString();
  }

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

  if (!fileBuffer && !markdownContent && !plainTextContent && !sourceUrl) {
    return c.json({ error: 'One of fileBufferBase64, markdownContent, plainTextContent, or sourceUrl must be provided' }, 400);
  }

  // Content fetched from a URL (populated inside the stream, before ingestion).
  let fetchedContentHash: string | undefined;

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
        // URL ingestion: fetch the page via the Cloudflare proxy and treat the
        // HTML exactly like an uploaded .html file. Done inside the stream so a
        // fetch failure (blocked host, timeout) surfaces as an SSE 'error'.
        if (sourceUrl && !fileBuffer) {
          emit('progress', { step: 'fetching' });
          const page = await fetchUnibenPage(sourceUrl as string);
          fileBuffer = new TextEncoder().encode(page.html);
          fetchedContentHash = page.contentHash;
        }

        const ingestOptions = {
          docId:       docId as string,
          fileName:    fileName as string,
          category:    category as string,
          namespace:   namespace as string,
          faculty:     resolvedFaculty,
          source:      source as string,
          roles:       rolesRaw,
          updatedAt:   resolvedUpdatedAt,
          institutionId,
          contentType: (contentType as ContentType | undefined) ?? 'general',
          programme:   (programme as string | undefined) || undefined,
          levels:      levelsRaw.length > 0 ? levelsRaw : undefined,
          fileBuffer,
          markdownContent:  markdownContent  as string | undefined,
          plainTextContent: plainTextContent as string | undefined,
          onProgress:  (p: IngestProgressEvent) => emit('progress', p),
        };

        // ── Dry run ──────────────────────────────────────────────────────────
        // Only prepareDocument is reachable from here, and it contains no write
        // of any kind — not the cross-namespace cleanup below, not the Pinecone
        // upsert, not the registry. The guarantee is structural rather than a
        // flag checked before each write.
        if (isDryRun) {
          const prepared = await prepareDocument(ingestOptions);
          const existingDoc = await getDocument(docId as string);
          emit('done', {
            success: true,
            dryRun: true,
            report: {
              ...summarizePrepared(prepared),
              /** True when a real ingest would replace an existing document. */
              replacesExisting: existingDoc !== null,
              /** Set when this run would also move the doc between namespaces. */
              movesFromNamespace:
                existingDoc && existingDoc.namespace !== namespace
                  ? existingDoc.namespace
                  : null,
              sourceUrl: (sourceUrl as string | undefined) ?? null,
              contentHash: fetchedContentHash ?? null,
            },
          });
          return;
        }

        // Ghost vector fix: cross-namespace cleanup before ingestion.
        const existing = await getDocument(docId as string);
        if (existing && existing.namespace !== namespace) {
          await deleteDocument(docId as string, existing.namespace);
        }

        const audit = await ingestDocument(ingestOptions);

        emit('progress', { step: 'saving' });

        const record: KbDocument = {
          ...audit,
          markdownContent:  (markdownContent  as string | undefined) ?? null,
          plainTextContent: (plainTextContent as string | undefined) ?? null,
          // URL-sourced docs record where they came from + the content hash, so a
          // future freshness check can re-fetch, compare, and re-ingest on change.
          sourceUrl:     (sourceUrl as string | undefined) ?? null,
          contentHash:   fetchedContentHash ?? null,
          lastFetchedAt: sourceUrl ? new Date().toISOString() : null,
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

// ── PATCH /kb/documents/:docId/scope ─────────────────────────────────────
// Edits roles/levels/programme/category/contentType on an already-ingested
// document without re-extracting, re-chunking, or re-embedding it — a single
// filter-based Pinecone metadata update, plus a matching SQLite registry sync.
//
// Only widens/changes non-empty scopes; cannot clear a scope back to "unscoped"
// (see the limitation documented on patchDocumentMetadata in ingest.ts). Use
// reingestDocumentHandler for that.
export async function patchDocumentScopeHandler(c: ContextWithMastra): Promise<Response> {
  if (!isAuthorized(c)) return c.json({ error: 'Unauthorized' }, 401);

  const docId = c.req.param('docId');
  if (!docId) return c.json({ error: 'Missing docId' }, 400);

  const doc = await getDocument(docId);
  if (!doc) return c.json({ error: 'Document not found' }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { roles, levels, programme, category, contentType, updatedAt } = body;
  const patch: DocumentScopePatch = {};

  if (roles !== undefined) {
    const rolesRaw = Array.isArray(roles) ? roles as string[] : [];
    if (rolesRaw.length === 0) return c.json({ error: 'roles must be a non-empty array' }, 400);
    const invalidRoles = rolesRaw.filter((r) => !VALID_ROLES.has(r));
    if (invalidRoles.length > 0) return c.json({ error: `Invalid roles: ${invalidRoles.join(', ')}` }, 400);
    patch.roles = rolesRaw;
  }

  if (levels !== undefined) {
    const levelsRaw = Array.isArray(levels) ? levels as string[] : [];
    if (levelsRaw.length === 0) return c.json({ error: 'levels cannot be cleared via patch — use reingest instead' }, 400);
    const invalidLevels = levelsRaw.filter((l) => !VALID_LEVELS.has(l));
    if (invalidLevels.length > 0) return c.json({ error: `Invalid levels: ${invalidLevels.join(', ')}` }, 400);
    patch.levels = levelsRaw;
  }

  if (programme !== undefined) {
    const programmeRaw = (programme as string).trim();
    if (!programmeRaw) return c.json({ error: 'programme cannot be cleared via patch — use reingest instead' }, 400);
    patch.programme = programmeRaw;
  }

  if (category !== undefined) {
    if (!VALID_CATEGORIES.has(category as string)) return c.json({ error: `Invalid category: ${category}` }, 400);
    patch.category = category as string;
  }

  if (contentType !== undefined) {
    if (!VALID_CONTENT_TYPES.has(contentType as string)) return c.json({ error: `Invalid contentType: ${contentType}` }, 400);
    patch.contentType = contentType as ContentType;
  }

  if (updatedAt !== undefined) {
    const d = new Date(updatedAt as string);
    if (isNaN(d.getTime())) return c.json({ error: 'Invalid updatedAt: must be a valid date string' }, 400);
    patch.updatedAt = d.toISOString();
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ error: 'No valid fields to patch' }, 400);
  }

  try {
    await patchDocumentMetadata(docId, doc.namespace, patch);
    const updated: KbDocument = { ...doc, ...patch };
    await saveDocument(updated);
    return c.json({ success: true, document: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
}

// ── DELETE /kb/documents/:docId ─────────────────────────────────────────
export async function deleteDocumentHandler(c: ContextWithMastra): Promise<Response> {
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
export async function reingestDocumentHandler(c: ContextWithMastra): Promise<Response> {
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
          // PRESERVE the content date. Re-ingesting re-processes a document; it
          // does not rewrite when that document was authored. Stamping `now`
          // here reset the staleness clock on every re-ingest, so a 2022
          // handbook silently lost its "may be outdated" warning and the model
          // could present a former office-holder as current with no caveat.
          //
          // The one case where `now` IS the truth: the freshness guardian
          // re-fetched a URL and the content hash actually changed, so this
          // version of the page demonstrably appeared now. That is signalled by
          // override.contentHash and nothing else.
          updatedAt:        override.contentHash ? nowIso : doc.updatedAt,
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
export async function updateFreshnessHandler(c: ContextWithMastra): Promise<Response> {
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
