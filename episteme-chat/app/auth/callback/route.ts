// app/auth/callback/route.ts
// The ONLY place that knows about role-based routing after auth.
// Server-side Route Handler — never sent to the client bundle.

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/chat";

  if (!code) {
    return NextResponse.redirect(`${origin}/sign-in?error=missing_code`);
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user: authUser }, error: sessionError } =
    await supabase.auth.exchangeCodeForSession(code);

  // ↑ exchangeCodeForSession returns the authenticated user directly —
  //   use it here instead of a separate getUser() call.
  if (sessionError || !authUser) {
    return NextResponse.redirect(`${origin}/sign-in?error=oauth_failed`);
  }

  // Always filter by auth_id — never rely on RLS alone.
  // Without this filter, maybeSingle() could return an arbitrary row for
  // superadmins (who have a policy that reads ALL users rows).
  const { data: profile } = await supabase
    .from("users")
    .select("id, status, institution_id, is_superadmin, roles")
    .eq("auth_id", authUser.id)
    .maybeSingle();

  // Audit sign-in (best-effort — never block the redirect).
  void supabase.rpc("fn_write_audit_log", {
    p_action:         "user_sign_in",
    p_resource_type:  "session",
    p_resource_id:    profile?.id ?? null,
    p_institution_id: profile?.institution_id ?? null,
  });

  // No profile, inactive, or missing institution → onboarding.
  // Superadmins are exempt from the institution_id requirement.
  const isSuperadmin = profile?.is_superadmin === true;
  if (!profile || profile.status !== "active") {
    return NextResponse.redirect(`${origin}/sign-in?error=inactive`);
  }
  if (!isSuperadmin && !profile.institution_id) {
    return NextResponse.redirect(`${origin}/onboarding`);
  }

  // If the caller supplied a specific `next`, honour it.
  if (next !== "/chat") {
    return NextResponse.redirect(`${origin}${next}`);
  }

  // Role-aware default routing: send each role to their own dashboard.
  const roles = (profile.roles as string[]) ?? [];
  if (isSuperadmin) {
    return NextResponse.redirect(`${origin}/superadmin`);
  }
  if (roles.includes("admin")) {
    return NextResponse.redirect(`${origin}/admin`);
  }
  if (roles.includes("hod")) {
    return NextResponse.redirect(`${origin}/hod`);
  }

  return NextResponse.redirect(`${origin}/chat`);
}