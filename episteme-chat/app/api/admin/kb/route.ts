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

import { createSupabaseServerClientReadOnly, createSupabaseServerClient } from "@/lib/supabase/server";

// Ingestion pipelines can take minutes for large PDFs (Unstructured + embedding + Pinecone upsert).
export const maxDuration = 300;

function mastraKbUrl(path = ""): string {
  const base = process.env.MASTRA_BASE_URL ?? "http://localhost:4111";
  return `${base.replace(/\/$/, "")}/kb/documents${path}`;
}

function adminKey(): string {
  const key = process.env.MASTRA_ADMIN_KEY;
  if (!key) throw new Error("MASTRA_ADMIN_KEY is not set");
  return key;
}

type AssertAdminResult =
  | { error: Response; institutionId: null }
  | { error: null; institutionId: string | null };

async function assertAdmin(requestedInstitutionId?: string | null): Promise<AssertAdminResult> {
  const supabase = await createSupabaseServerClientReadOnly();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: Response.json({ error: "Unauthorized" }, { status: 401 }), institutionId: null };
  }

  const { data: rows, error: rpcError } = await supabase.rpc("fn_assert_active_admin");
  if (rpcError || !rows || rows.length === 0) {
    const status = rpcError?.code === "P0002" ? 403 : 401;
    return { error: Response.json({ error: status === 403 ? "Forbidden" : "Unauthorized" }, { status }), institutionId: null };
  }

  const profile = rows[0] as { user_id: string; is_superadmin: boolean; institution_id: string | null };

  const institutionId: string | null = profile.is_superadmin
    ? (requestedInstitutionId ?? profile.institution_id ?? null)
    : (profile.institution_id ?? null);

  const { data: scopeValid } = await supabase
    .rpc("fn_validate_institution_scope", { p_institution_id: institutionId });

  if (!scopeValid) {
    return { error: Response.json({ error: "Forbidden: invalid institution scope" }, { status: 403 }), institutionId: null };
  }

  return { error: null, institutionId };
}

function adminHeaders(institutionId: string | null): HeadersInit {
  const headers: Record<string, string> = { "x-episteme-admin-key": adminKey() };
  if (institutionId) headers["x-episteme-institution-id"] = institutionId;
  return headers;
}

// ── GET /api/admin/kb ────────────────────────────────────────────────────────
export async function GET() {
  const { error, institutionId } = await assertAdmin();
  if (error) return error;

  try {
    const res  = await fetch(mastraKbUrl(), { headers: adminHeaders(institutionId) });
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

  const { error, institutionId } = await assertAdmin(requestedInstitutionId);
  if (error) return error;

  let mastraRes: Response;
  try {
    mastraRes = await fetch(mastraKbUrl(), {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders(institutionId) },
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
  const sourceUrl = source?.startsWith("http") ? source : null;
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
              const payload = JSON.parse(dataMatch[1]) as { success?: boolean };
              if (payload.success && docId && institutionId) {
                // Fire-and-forget — stream is already flowing, don't block it.
                Promise.all([
                  supabase.from("kb_document_sources").upsert(
                    { doc_id: docId, institution_id: institutionId, source_url: sourceUrl, updated_at: new Date().toISOString() },
                    { onConflict: "doc_id" },
                  ),
                  supabase.rpc("fn_write_audit_log_for_kb", {
                    p_action:        "kb_document_created",
                    p_resource_type: "kb_document",
                    p_new_value:     { doc_id: docId ?? null, source: source ?? null },
                  }),
                ]).catch((err) => console.error("[admin/kb] Supabase sync failed:", err));
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
