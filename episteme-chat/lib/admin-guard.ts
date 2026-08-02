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
//
// Both steps are request-cached (see lib/supabase/server-auth.ts), so a page
// calling this after the layout already guarded costs no extra round-trips.
// The atomic assertion is still what decides access — caching only stops the
// same check from executing twice within one request.

import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getAdminAssertion, getAuthUser, getServerSupabase } from "@/lib/supabase/server-auth";

type SupabaseSSRClient = Awaited<ReturnType<typeof createSupabaseServerClientReadOnly>>;

export type AdminAccessResult = {
  supabase: SupabaseSSRClient;
  isSuperadmin: boolean;
  institutionId: string;
};

export async function requireAdminAccess(
  institutionParam: string | undefined,
): Promise<AdminAccessResult> {
  const supabase = await getServerSupabase();

  // Step 1: validate JWT.
  const authUser = await getAuthUser();
  if (!authUser) redirect("/sign-in");

  // Step 2: atomic role + status check.
  const { row: profile, error: rpcError } = await getAdminAssertion();

  if (rpcError || !profile) {
    const isForbidden = rpcError?.code === "P0002";
    redirect(isForbidden ? "/chat" : "/sign-in");
  }

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