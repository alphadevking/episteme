import "server-only";

import { cache } from "react";
import { getServerSupabase, getUserProfile } from "@/lib/supabase/server-auth";
import {
  resolveEffectiveRole,
  resolveRetrievalRoles,
  isPlatformAdmin,
  deriveTrustLevel,
} from "@/lib/session-derivation";
import { getSuggestions, type Suggestion } from "@/lib/suggestions";

/**
 * The suggestion set for the signed-in user.
 *
 * THE POINT OF THIS MODULE: it derives role, trust and the operator bit with the
 * SAME functions, in the SAME order, as /api/chat does when it actually runs the
 * query. Chips and queries are then incapable of disagreeing.
 *
 * That was the previous bug in miniature — the page filtered chips by
 * `primary_role` while the route queried with `resolveRetrievalRoles`, so a user
 * with roles ['student','hod'] was shown one role's chips and searched with
 * another's. Any future change to the derivation has to be made once, here and
 * in the route, and the divergence is visible in review.
 *
 * Request-cached: both /chat and /chat/[threadId] call it, and the extra reads
 * are shared with the auth/profile fetches those pages already make.
 */
export const getSuggestionsForCurrentUser = cache(async (): Promise<Suggestion[]> => {
  const profile = await getUserProfile();

  // No profile → the floor. Fails closed: the public chips only.
  if (!profile?.id) {
    return getSuggestions({ roles: ["prospective"], trustLevel: 1 });
  }

  const primaryRole = profile.primary_role ?? "prospective";
  const rawRoles    = (profile.roles as string[] | null) ?? [];

  // Single highest-priority role — used for display and, per the route, as the
  // input to deriveTrustLevel. NOT used for access.
  const effectiveRole  = resolveEffectiveRole(primaryRole, rawRoles);
  // Access is the union of every verified role.
  const retrievalRoles = resolveRetrievalRoles(primaryRole, rawRoles);
  const platformAdmin  = isPlatformAdmin(primaryRole, rawRoles);

  const isParent =
    effectiveRole === "parent" || effectiveRole === "guardian" ||
    rawRoles.includes("parent") || rawRoles.includes("guardian");

  const supabase = await getServerSupabase();

  const [aiCtxResult, parentLinkResult] = await Promise.all([
    supabase
      .from("user_ai_context")
      .select("trust_level")
      .eq("user_id", profile.id)
      .maybeSingle(),

    isParent
      ? supabase
          .from("parent_student_links")
          .select("can_view_academic, can_view_fees")
          .eq("parent_user_id", profile.id)
          .eq("verification_status", "verified")
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // Trust comes from the VERIFIED role (elevated → 4); the stored value is only
  // ever a ceiling-bounded hint, never a promotion. Same rule as the route.
  const trustLevel = deriveTrustLevel(effectiveRole, aiCtxResult.data?.trust_level);

  // Mirrors the route's allowlist construction. Narrows only.
  let namespaceAllowlist: string[] | null = null;
  if (isParent) {
    const link = parentLinkResult.data;
    const allowed = ["admissions", "general"];
    if (link?.can_view_fees)     allowed.push("financial-aid");
    if (link?.can_view_academic) allowed.push("academic-policy", "programmes");
    namespaceAllowlist = allowed;
  }

  return getSuggestions({
    roles:              retrievalRoles,
    trustLevel,
    isPlatformAdmin:    platformAdmin,
    namespaceAllowlist,
  });
});
