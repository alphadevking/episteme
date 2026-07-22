// app/api/admin/kb/[docId]/route.ts
// Per-document operations: delete, reingest, and scope patch.
//
// Same institution resolution model as kb/route.ts:
//   - Superadmin: may target any active institution; defaults to own if not specified.
//   - Regular admin: always their own institution from DB.
//
// kb_document_sources sync:
//   DELETE → remove row from kb_document_sources.
//   POST (reingest) → touch last_changed_at in kb_document_sources.
//   PATCH (scope) → no kb_document_sources fields affected; audit log only.

import { createSupabaseServerClientReadOnly, createSupabaseServerClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export const maxDuration = 300;

// Route path whose Server Component data must be invalidated after any KB
// mutation. router.refresh() alone only clears the client cache and can
// re-produce a stale render; revalidatePath makes invalidation server-authoritative.
const KB_ADMIN_PATH = "/admin/knowledge";

type Params = { params: Promise<{ docId: string }> };

function mastraKbUrl(docId: string, suffix = ""): string {
  const base = process.env.MASTRA_BASE_URL ?? "http://localhost:4111";
  return `${base.replace(/\/$/, "")}/kb/documents/${encodeURIComponent(docId)}${suffix}`;
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

// ── DELETE /api/admin/kb/:docId ──────────────────────────────────────────────
export async function DELETE(req: Request, { params }: Params) {
  let requestedInstitutionId: string | null | undefined;
  try {
    const body = await req.clone().json();
    requestedInstitutionId = body?.institutionId ?? null;
  } catch { /* no body — fine */ }

  const { error, institutionId } = await assertAdmin(requestedInstitutionId);
  if (error) return error;

  const { docId } = await params;

  try {
    const res  = await fetch(mastraKbUrl(docId), {
      method:  "DELETE",
      headers: adminHeaders(institutionId),
    });
    const data = await res.json();

    if (res.ok) {
      const supabase = await createSupabaseServerClient();

      // Remove from kb_document_sources — document no longer exists in Pinecone or LibSQL.
      await supabase
        .from("kb_document_sources")
        .delete()
        .eq("doc_id", docId);

      await supabase.rpc("fn_write_audit_log_for_kb", {
        p_action:        "kb_document_deleted",
        p_resource_type: "kb_document",
        p_old_value:     { doc_id: docId },
      });

      revalidatePath(KB_ADMIN_PATH);
    }

    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 503 });
  }
}

// ── PATCH /api/admin/kb/:docId ───────────────────────────────────────────────
// Body: { roles?, levels?, programme?, category?, contentType?, institutionId? }
// Edits scope/classification metadata on an already-ingested document without
// re-running extraction/chunking/embedding. See patchDocumentScopeHandler in
// episteme-core for field constraints (e.g. levels/programme cannot be cleared
// to empty via patch — that requires reingest).
export async function PATCH(req: Request, { params }: Params) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const requestedInstitutionId = body.institutionId as string | null | undefined;
  const { error, institutionId } = await assertAdmin(requestedInstitutionId);
  if (error) return error;

  const { docId } = await params;
  const { roles, levels, programme, category, contentType } = body;

  try {
    const res  = await fetch(mastraKbUrl(docId, "/scope"), {
      method:  "PATCH",
      headers: { "Content-Type": "application/json", ...adminHeaders(institutionId) },
      body:    JSON.stringify({ roles, levels, programme, category, contentType }),
    });
    const data = await res.json();

    if (res.ok) {
      const supabase = await createSupabaseServerClient();
      await supabase.rpc("fn_write_audit_log_for_kb", {
        p_action:        "kb_document_scope_updated",
        p_resource_type: "kb_document",
        p_new_value:     { doc_id: docId, roles, levels, programme, category, contentType },
      });

      revalidatePath(KB_ADMIN_PATH);
    }

    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 503 });
  }
}

/**
 * Re-ingest streams its progress back as Server-Sent Events (text/event-stream),
 * terminating with `event: done` on success or `event: error` on failure — it is
 * NOT a JSON response. Calling res.json() on it throws, which previously made
 * every re-ingest look like a 503 in the UI and never refresh the table. We
 * consume the stream to completion instead and collapse it to a single JSON
 * result the table's fetch() can read.
 */
function readSseOutcome(raw: string): { ok: true } | { ok: false; error: string } {
  for (const block of raw.split("\n\n")) {
    if (/^event:\s*error/m.test(block)) {
      const data = block.match(/^data:\s*(.*)$/m)?.[1];
      let message = "Re-ingestion failed.";
      if (data) {
        try { message = (JSON.parse(data) as { error?: string }).error ?? message; } catch { /* keep default */ }
      }
      return { ok: false, error: message };
    }
  }
  // Success requires an explicit terminal `done` — a stream that ends without it
  // (dropped connection, crash) must not be reported as a successful re-ingest.
  if (/^event:\s*done/m.test(raw)) return { ok: true };
  return { ok: false, error: "Re-ingestion ended without completing." };
}

// ── POST /api/admin/kb/:docId/reingest ───────────────────────────────────────
export async function POST(req: Request, { params }: Params) {
  let requestedInstitutionId: string | null | undefined;
  try {
    const body = await req.clone().json();
    requestedInstitutionId = body?.institutionId ?? null;
  } catch { /* no body — fine */ }

  const { error, institutionId } = await assertAdmin(requestedInstitutionId);
  if (error) return error;

  const { docId } = await params;

  try {
    const res = await fetch(mastraKbUrl(docId, "/reingest"), {
      method:  "POST",
      headers: adminHeaders(institutionId),
    });

    // Pre-stream failures (401/404/422) are returned by Mastra as JSON, not SSE.
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `Re-ingestion failed (${res.status}).` }));
      return Response.json(data, { status: res.status });
    }

    // Success path streams SSE — consume it fully, then inspect the terminal event.
    const raw     = await res.text();
    const outcome = readSseOutcome(raw);

    if (!outcome.ok) {
      return Response.json({ error: outcome.error }, { status: 500 });
    }

    const supabase = await createSupabaseServerClient();

    // Touch last_changed_at — content was re-processed and re-embedded.
    await supabase
      .from("kb_document_sources")
      .update({
        last_changed_at: new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      })
      .eq("doc_id", docId);

    await supabase.rpc("fn_write_audit_log_for_kb", {
      p_action:        "kb_document_reingested",
      p_resource_type: "kb_document",
      p_new_value:     { doc_id: docId },
    });

    revalidatePath(KB_ADMIN_PATH);

    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 503 });
  }
}
