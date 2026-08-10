// app/chat/settings/page.tsx
// Server component — loads everything the settings shell renders, then hands it
// over as one `SettingsData` object.
//
// The reads are issued as a single parallel batch. They are all narrow
// single-row (or small list) selects against indexed columns, and the page is
// dynamic anyway because it depends on the session, so the round trips — not
// the payload — are the cost worth minimising.
import { redirect } from "next/navigation";
import { SettingsShell } from "@/components/user/settings-shell";
import type { SettingsData, SettingsOption, SettingsWard } from "@/lib/settings/types";
import { readSettingsValues } from "@/lib/settings/patch";
import { getAuthContext, getServerSupabase } from "@/lib/supabase/server-auth";
import { deriveTrustLevel, resolveEffectiveRole } from "@/lib/session-derivation";
import { getProviderAvatarUrl } from "@/lib/user-info";

export default async function SettingsPage() {
  // Request-cached — reuses the chat layout's auth call and profile row.
  const [supabase, { user, profile }] = await Promise.all([
    getServerSupabase(),
    getAuthContext(),
  ]);

  if (!user) redirect("/sign-in");
  if (!profile) redirect("/onboarding");

  const institutionId = profile.institution_id;
  const roles         = (profile.roles as string[]) ?? [];
  const primaryRole   = profile.primary_role ?? "prospective";
  const effectiveRole = resolveEffectiveRole(primaryRole, roles);

  const [
    { data: aiCtx },
    { data: accountMeta },
    { data: institution },
    { data: studentLink },
    { data: wardLinks },
    { data: programmes },
    { data: departments },
  ] = await Promise.all([
    supabase
      .from("user_ai_context")
      .select("programme, level, preferences, trust_level")
      .eq("user_id", profile.id)
      .maybeSingle(),

    // Account metadata that PROFILE_COLUMNS deliberately doesn't carry — it is
    // the union of what the chat tree needs on every request, and none of the
    // chat tree needs "member since".
    supabase
      .from("users")
      .select("created_at, last_login_at, email_verified_at")
      .eq("id", profile.id)
      .maybeSingle(),

    institutionId
      ? supabase.from("institutions").select("name").eq("id", institutionId).maybeSingle()
      : Promise.resolve({ data: null }),

    supabase
      .from("user_student_links")
      .select("matric_number, verification_status, rejection_reason, verified_at, verification_method")
      .eq("user_id", profile.id)
      .maybeSingle(),

    // Run unconditionally: it is a cheap indexed lookup that returns nothing
    // for a non-parent, and it keeps the result a single row type rather than a
    // union with a `never[]` fallback.
    supabase
      .from("parent_student_links")
      .select(
        "relationship_type, verification_status, claimed_matric, can_view_academic, can_view_fees, can_view_attendance, users:student_user_id(first_name, last_name)",
      )
      .eq("parent_user_id", profile.id),

    institutionId
      ? supabase
          .from("programs")
          .select("id, name, code")
          .eq("institution_id", institutionId)
          .eq("is_active", true)
          .order("name")
      : Promise.resolve({ data: [] }),

    institutionId
      ? supabase
          .from("departments")
          .select("id, name, code")
          .eq("institution_id", institutionId)
          .eq("is_active", true)
          .order("name")
      : Promise.resolve({ data: [] }),
  ]);

  const wards: SettingsWard[] = (wardLinks ?? []).map((link) => {
    const student = (Array.isArray(link.users) ? link.users[0] : link.users) as
      | { first_name: string | null; last_name: string | null }
      | null;
    const name = [student?.first_name, student?.last_name].filter(Boolean).join(" ");
    return {
      name:              name || null,
      matric:            link.claimed_matric,
      relationship:      link.relationship_type,
      status:            link.verification_status,
      canViewAcademic:   link.can_view_academic,
      canViewFees:       link.can_view_fees,
      canViewAttendance: link.can_view_attendance,
    };
  });

  const data: SettingsData = {
    values: readSettingsValues(profile, aiCtx ?? null),

    account: {
      email:           profile.email,
      emailVerified:   Boolean(accountMeta?.email_verified_at),
      provider:        (user.app_metadata?.provider as string | undefined) ?? null,
      status:          profile.status,
      primaryRole,
      roles,
      isSuperadmin:    profile.is_superadmin,
      institutionName: institution?.name ?? null,
      // Kept as two values, not one resolved string: the UI has to distinguish
      // "you uploaded this" (removable) from "your sign-in provider supplied
      // this" (not ours to delete). resolveAvatarUrl encodes the precedence
      // between them and is shared with the sidebar badge so the two surfaces
      // cannot disagree about which photo is current.
      uploadedAvatarUrl: profile.avatar_url,
      providerAvatarUrl: getProviderAvatarUrl(user),
      createdAt:       accountMeta?.created_at ?? null,
      lastLoginAt:     accountMeta?.last_login_at ?? null,
    },

    verification: studentLink
      ? {
          matricNumber:    studentLink.matric_number,
          status:          studentLink.verification_status,
          rejectionReason: studentLink.rejection_reason,
          verifiedAt:      studentLink.verified_at,
          method:          studentLink.verification_method,
        }
      : null,

    wards,

    // Same derivation the chat route forwards to episteme-core, so what this
    // page tells the user about their access is what retrieval actually enforces.
    trustLevel:    deriveTrustLevel(effectiveRole, aiCtx?.trust_level),
    effectiveRole,

    programmes:  (programmes  ?? []) as SettingsOption[],
    departments: (departments ?? []) as SettingsOption[],
  };

  return <SettingsShell data={data} />;
}
