// app/sign-in/page.tsx
// Server component — redirects authenticated users to their role-appropriate
// dashboard, or passes the ?next= param through to SignInForm so it survives
// the OAuth/magic-link round trip (used by invite redemption flow).

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { SignInForm } from "@/app/chat/sign-in-form";

type Props = { searchParams: Promise<Record<string, string | undefined>> };

export default async function SignInPage({ searchParams }: Props) {
  const sp   = await searchParams;
  const next = sp.next ?? "/chat";

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    const { data: profile } = await supabase
      .from("users")
      .select("status, institution_id, is_superadmin, roles")
      .eq("auth_id", user.id)
      .maybeSingle();

    if (!profile || profile.status !== "active") {
      redirect("/onboarding");
    }
    if (!profile.institution_id && !profile.is_superadmin) {
      redirect("/onboarding");
    }

    // Role-aware redirect — same order as auth/callback
    const roles = (profile.roles as string[]) ?? [];
    if (profile.is_superadmin)       redirect("/superadmin");
    if (roles.includes("admin"))     redirect("/admin");
    if (roles.includes("hod"))       redirect("/hod");
    redirect("/chat");
  }

  return <SignInForm next={next} />;
}