// lib/resolve-institution.ts
// Shared helper used by admin layout + all admin pages.
// Superadmins resolve institution from URL param.
// Regular admins resolve from their users row.
import type { SupabaseClient } from "@supabase/supabase-js";

export async function resolveInstitutionId(
  supabase: SupabaseClient,
  isSuperadmin: boolean,
  paramId?: string,
): Promise<string | null> {
  if (isSuperadmin) {
    // Superadmin must provide ?institution=<id> in the URL
    return paramId ?? null;
  }
  // Regular admin — institution fixed to their account
  const { data } = await supabase
    .from("users")
    .select("institution_id")
    .maybeSingle();
  return data?.institution_id ?? null;
}