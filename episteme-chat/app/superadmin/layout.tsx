// app/superadmin/layout.tsx
// Uses fn_assert_active_admin() for atomic role + status check.
// The two-step pattern (getUser → SELECT) is vulnerable to TOCTOU
// if a superadmin's account is suspended between the two queries.

import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { getAdminAssertion, getAuthUser, getUserProfile } from "@/lib/supabase/server-auth";

export default async function SuperadminLayout({ children }: { children: ReactNode }) {
  // Step 1: validate JWT.
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  // Step 2: atomic check — also validates status and deleted_at.
  // Request-cached; the pages below reuse this assertion rather than repeating it.
  const { row: profile, error } = await getAdminAssertion();

  if (error || !profile) {
    redirect(error?.code === "P0002" ? "/chat" : "/sign-in");
  }

  // /superadmin requires is_superadmin — admins without the flag go to /admin.
  if (!profile.is_superadmin) redirect("/admin");

  const displayProfile = await getUserProfile();

  return (
    <AdminShell
      tier="superadmin"
      userName={displayProfile?.first_name ?? "Admin"}
      isSuperadmin={true}
    >
      {children}
    </AdminShell>
  );
}