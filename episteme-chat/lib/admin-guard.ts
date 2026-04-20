// lib/admin-guard.ts
// Single source of truth for admin/superadmin access in all /admin/* pages.
//
// Superadmin institution model:
//   - is_superadmin=true, institution_id=null (global superadmin):
//       Must supply ?institution= URL param to enter an institution's admin panel,
//       or lands on /superadmin (the cross-institution dashboard).
//
//   - is_superadmin=true, institution_id=set (dual-role):
//       Has their own institution but can STILL override to any institution via
//       ?institution= URL param. If no param supplied, falls back to their own
//       institution_id so they land directly in their home institution's panel.
//
//   - is_superadmin=false, institution_id=set (regular admin):
//       Always scoped to their own institution_id. URL param is ignored.
//
// Auth pattern:
//   1. auth.getUser()           — validates JWT with Supabase Auth server
//   2. fn_assert_active_admin() — atomic: status, deleted_at, role in one query

import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

type SupabaseSSRClient = Awaited<ReturnType<typeof createSupabaseServerClientReadOnly>>;

export type AdminAccessResult = {
  supabase: SupabaseSSRClient;
  isSuperadmin: boolean;
  institutionId: string;
};

export async function requireAdminAccess(
  institutionParam: string | undefined,
): Promise<AdminAccessResult> {
  const supabase = await createSupabaseServerClientReadOnly();

  // Step 1: validate JWT.
  const { data: { user: authUser } } = await supabase.auth.getUser();
  if (!authUser) redirect("/sign-in");

  // Step 2: atomic role + status check.
  const { data: rows, error: rpcError } = await supabase.rpc("fn_assert_active_admin");

  if (rpcError || !rows || rows.length === 0) {
    const isForbidden = rpcError?.code === "P0002";
    redirect(isForbidden ? "/chat" : "/sign-in");
  }

  const profile = rows[0] as {
    user_id:        string;
    is_superadmin:  boolean;
    institution_id: string | null;
  };

  const isSuperadmin = profile.is_superadmin === true;

  let institutionId: string | null;

  if (isSuperadmin) {
    // Superadmins can always target any institution via the URL param.
    // If no param is given, fall back to their own institution_id (dual-role case).
    // If neither exists, they need to pick from /superadmin.
    institutionId = institutionParam ?? profile.institution_id ?? null;
  } else {
    // Regular admins are always scoped to their DB institution — never the URL param.
    institutionId = profile.institution_id ?? null;
  }

  if (!institutionId) redirect(isSuperadmin ? "/superadmin" : "/chat");

  return { supabase, isSuperadmin, institutionId };
}