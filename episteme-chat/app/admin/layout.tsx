// app/admin/layout.tsx
// Layouts cannot read searchParams in Next.js App Router.
// This layout only handles auth + role guarding.
// Institution resolution happens in each page component via requireAdminAccess().
//
// Uses fn_assert_active_admin() — a single atomic SECURITY DEFINER call —
// instead of a two-step auth.getUser() + profile SELECT, which is vulnerable
// to TOCTOU (role revocation between the two queries).

import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { getAdminAssertion, getAuthUser, getUserProfile } from "@/lib/supabase/server-auth";

type Props = { children: ReactNode };

export default async function AdminLayout({ children }: Props) {
  // Step 1: validate JWT — must happen before any RPC call.
  const authUser = await getAuthUser();
  if (!authUser) redirect("/sign-in");

  // Step 2: atomic role + status check via SECURITY DEFINER function.
  // Raises P0001 (not found / inactive) or P0002 (not admin/superadmin).
  // Request-cached, so the pages below reuse this exact assertion instead of
  // re-running it — see the note in server-auth.ts.
  const { row: profile, error } = await getAdminAssertion();

  if (error || !profile) {
    // P0002 = authenticated but not an admin → send to chat
    // P0001 / anything else → session issue → sign-in
    redirect(error?.code === "P0002" ? "/chat" : "/sign-in");
  }

  const isSuperadmin = profile.is_superadmin === true;

  // Regular admins without an institution haven't completed onboarding.
  if (!isSuperadmin && !profile.institution_id) redirect("/onboarding");

  // Display name — fn_assert_active_admin doesn't return it.
  const displayProfile = await getUserProfile();

  return (
    <AdminShell
      tier="admin"
      userName={displayProfile?.first_name ?? "Admin"}
      isSuperadmin={isSuperadmin}
    >
      {children}
    </AdminShell>
  );
}