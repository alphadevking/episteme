// app/api/admin/kb/route.ts
// Admin-only proxy to episteme-core KB routes.
//
// Institution resolution:
//   - Superadmin: may specify any active institution via request body scope.
//     If none provided, defaults to their own institution_id (dual-role) or
//     null (global — no institution filter passed to Mastra).
//   - Regular admin: always their own institution_id from DB. Body scope
//     institution is ignored (fn_validate_institution_scope enforces this).
//
// All checks run through two atomic RPCs:
//   fn_assert_active_admin()        — status + role check
//   fn_validate_institution_scope() — explicit institution ownership check
//
// kb_document_sources sync:
//   On successful ingest → upsert row (doc_id, institution_id, source_url if URL).
//   Supabase is the source of truth for the admin dashboard; LibSQL is Mastra-internal.

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/types/database";
import { assertKbAdmin, kbAdminHeaders, mastraBaseUrl } from "@/lib/admin/kb-auth";
import { shouldRecordIngest, type IngestDonePayload } from "@/lib/admin/kb-sync";
import { revalidatePath } from "next/cache";

// Ingestion pipelines can take minutes for large PDFs (Unstructured + embedding + Pinecone upsert).
export const maxDuration = 300;

// Server-authoritative invalidation of the KB admin list after a successful ingest.
const KB_ADMIN_PATH = "/admin/knowledge";

function mastraKbUrl(path = ""): string {
  return `${mastraBaseUrl()}/kb/documents${path}`;
}

// ── GET /api/admin/kb ────────────────────────────────────────────────────────
export async function GET() {
  const { error, institutionId } = await assertKbAdmin();
  if (error) return error;

  try {
    const res  = await fetch(mastraKbUrl(), { headers: kbAdminHeaders(institutionId) });
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 503 });
  }
}

// ── POST /api/admin/kb ───────────────────────────────────────────────────────
// Proxies to Mastra's SSE ingest endpoint and forwards the stream to the browser.
// Intercepts the `done` event to sync Supabase (kb_document_sources + audit log)
// without blocking the stream — the browser sees all progress in real-time.
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const requestedInstitutionId = (body.scope as Record<string, unknown> | undefined)
    ?.institutionId as string | null | undefined;

  const { error, institutionId } = await assertKbAdmin(requestedInstitutionId);
  if (error) return error;

  // A preview writes nothing upstream — core's dryRun path reaches only
  // prepareDocument — so nothing may be recorded downstream either. Read from
  // the REQUEST, not from the stream's `done` payload: the authority on whether
  // this was a preview is what we asked for. Without this, previewing a page
  // would register it in kb_document_sources and file a
  // "kb_document_created" audit entry for a document that does not exist.
  const isDryRun = body.dryRun === true;

  let mastraRes: Response;
  try {
    mastraRes = await fetch(mastraKbUrl(), {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...kbAdminHeaders(institutionId) },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 503 });
  }

  // Mastra returns JSON (not SSE) for validation errors — forward as-is.
  const mastraContentType = mastraRes.headers.get("content-type") ?? "";
  if (!mastraContentType.includes("text/event-stream")) {
    const data = await mastraRes.json();
    return Response.json(data, { status: mastraRes.status });
  }

  if (!mastraRes.body) {
    return Response.json({ error: "No stream from ingestion service" }, { status: 503 });
  }

  // Capture scope for the Supabase side-effect.
  const docId     = body.docId     as string | undefined;
  const source    = body.source    as string | undefined;

  // Prefer the explicit sourceUrl. The old heuristic — "source looks like a
  // URL" — holds for the single-document form, which puts the URL in both
  // fields, but not for a harvest entry, whose `source` is a human citation
  // label ("UNIBEN — Admission Requirements"). Those rows would have recorded
  // a null source_url and dropped out of any future freshness re-check.
  const explicitSourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl : null;
  const sourceUrl = explicitSourceUrl ?? (source?.startsWith("http") ? source : null);
  const supabase  = await createSupabaseServerClient();

  // Pipe Mastra's SSE stream to the browser.
  // Parse each event block to detect `done` and fire Supabase ops fire-and-forget.
  const decoder = new TextDecoder();
  let sseBuffer  = "";

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = mastraRes.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Forward raw bytes immediately — browser sees events as they arrive.
          controller.enqueue(value);

          // Parse for the `done` event to trigger Supabase sync.
          sseBuffer += decoder.decode(value, { stream: true });
          const blocks  = sseBuffer.split("\n\n");
          sseBuffer     = blocks.pop() ?? "";

          for (const block of blocks) {
            const evtMatch  = block.match(/^event: (\w+)/m);
            const dataMatch = block.match(/^data: (.+)/m);
            if (evtMatch?.[1] !== "done" || !dataMatch) continue;

            try {
              const payload = JSON.parse(dataMatch[1]) as IngestDonePayload;
              if (shouldRecordIngest({ requestedDryRun: isDryRun, payload, docId, institutionId })) {
                // Fire-and-forget — stream is already flowing, don't block it.
                const writes: PromiseLike<unknown>[] = [
                  supabase.rpc("fn_write_audit_log_for_kb", {
                    p_action:        "kb_document_created",
                    p_resource_type: "kb_document",
                    p_new_value:     { doc_id: docId ?? null, source: source ?? null } as Json,
                  }),
                ];

                // shouldRecordIngest already rejects a missing docId or
                // institutionId, but TS can't see through a boolean predicate
                // over a destructured literal — and it never checked sourceUrl,
                // which is NOT NULL on kb_document_sources. An ingest with no
                // resolvable source URL was therefore attempting a null write
                // that the fire-and-forget catch below swallowed silently.
                // Skip the row instead; the audit log still records the ingest.
                if (docId && institutionId && sourceUrl) {
                  writes.push(
                    supabase.from("kb_document_sources").upsert(
                      {
                        doc_id:         docId,
                        institution_id: institutionId,
                        source_url:     sourceUrl,
                        updated_at:     new Date().toISOString(),
                      },
                      { onConflict: "doc_id" },
                    ),
                  );
                } else {
                  console.warn("[admin/kb] no source URL for", docId, "— skipping kb_document_sources row");
                }

                Promise.all(writes).catch((err) => console.error("[admin/kb] Supabase sync failed:", err));

                // Invalidate the KB admin list so the newly ingested doc shows
                // without a full page reload.
                revalidatePath(KB_ADMIN_PATH);
              }
            } catch { /* malformed data — skip */ }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
