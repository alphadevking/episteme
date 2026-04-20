// app/api/admin/kb/[docId]/route.ts
// Per-document operations: delete and reingest.
//
// Same institution resolution model as kb/route.ts:
//   - Superadmin: may target any active institution; defaults to own if not specified.
//   - Regular admin: always their own institution from DB.
//
// kb_document_sources sync:
//   DELETE → remove row from kb_document_sources.
//   POST (reingest) → touch last_changed_at in kb_document_sources.

import { createSupabaseServerClientReadOnly, createSupabaseServerClient } from "@/lib/supabase/server";

type Params = { params: Promise<{ docId: string }> };

function mastraKbUrl(docId: string, suffix = ""): string {
  const base = process.env.MASTRA_BASE_URL ?? "http://localhost:4111";
  return `${base.replace(/\/$/, "")}/api/kb/documents/${encodeURIComponent(docId)}${suffix}`;
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
    }

    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 503 });
  }
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
    const res  = await fetch(mastraKbUrl(docId, "/reingest"), {
      method:  "POST",
      headers: adminHeaders(institutionId),
    });
    const data = await res.json();

    if (res.ok) {
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
    }

    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 503 });
  }
}
