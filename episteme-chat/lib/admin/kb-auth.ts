// lib/admin/kb-auth.ts
/**
 * The admin gate and upstream credentials shared by every /api/admin/kb* route.
 *
 * WHY THIS IS SHARED: this check was copy-pasted verbatim into two route
 * files, and the harvest UI needs it in two more. Four copies of one
 * authorization decision is four places for one copy to be updated and the
 * others not — and the failure mode of that drift is a route that authorizes
 * more than the others, which nothing would notice.
 *
 * Institution resolution:
 *   - Superadmin: may target any active institution via the request. If none
 *     is given, falls back to their own institution_id (dual-role) or null
 *     (global — no institution filter passed to Mastra).
 *   - Regular admin: always their own institution_id from the database. A
 *     requested institution is ignored, and fn_validate_institution_scope
 *     enforces that independently of this code.
 *
 * Both checks are atomic RPCs rather than client-side reads:
 *   fn_assert_active_admin()        — status + role in one query
 *   fn_validate_institution_scope() — explicit institution ownership
 */
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";

export type KbAdminResult =
  | { error: Response; institutionId: null }
  | { error: null; institutionId: string | null };

export async function assertKbAdmin(
  requestedInstitutionId?: string | null,
): Promise<KbAdminResult> {
  const supabase = await createSupabaseServerClientReadOnly();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: Response.json({ error: "Unauthorized" }, { status: 401 }), institutionId: null };
  }

  const { data: rows, error: rpcError } = await supabase.rpc("fn_assert_active_admin");
  if (rpcError || !rows || rows.length === 0) {
    const status = rpcError?.code === "P0002" ? 403 : 401;
    return {
      error: Response.json({ error: status === 403 ? "Forbidden" : "Unauthorized" }, { status }),
      institutionId: null,
    };
  }

  const profile = rows[0] as { user_id: string; is_superadmin: boolean; institution_id: string | null };

  const institutionId: string | null = profile.is_superadmin
    ? (requestedInstitutionId ?? profile.institution_id ?? null)
    : (profile.institution_id ?? null);

  // null is a meaningful argument here — a superadmin with no institution of
  // their own. Supabase typegen renders the nullable uuid param as a required
  // `string`, so the cast is needed to express what the function already
  // accepts; omitting the key instead would change which overload PostgREST
  // resolves. See the same note in lib/hooks/use-onboarding.ts.
  const { data: scopeValid } = await supabase
    .rpc("fn_validate_institution_scope", {
      p_institution_id: institutionId as unknown as string,
    });

  if (!scopeValid) {
    return {
      error: Response.json({ error: "Forbidden: invalid institution scope" }, { status: 403 }),
      institutionId: null,
    };
  }

  return { error: null, institutionId };
}

/** Base URL of episteme-core. */
export function mastraBaseUrl(): string {
  return (process.env.MASTRA_BASE_URL ?? "http://localhost:4111").replace(/\/$/, "");
}

/**
 * Headers for a call into core. Throws when the shared key is missing, so a
 * misconfigured deployment fails loudly at the first request rather than
 * sending unauthenticated calls that core rejects with an opaque 401.
 */
export function kbAdminHeaders(institutionId: string | null): Record<string, string> {
  const key = process.env.MASTRA_ADMIN_KEY;
  if (!key) throw new Error("MASTRA_ADMIN_KEY is not set");

  const headers: Record<string, string> = { "x-episteme-admin-key": key };
  if (institutionId) headers["x-episteme-institution-id"] = institutionId;
  return headers;
}
