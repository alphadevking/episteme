// app/superadmin/layout.tsx
// Uses fn_assert_active_admin() for atomic role + status check.
// The two-step pattern (getUser → SELECT) is vulnerable to TOCTOU
// if a superadmin's account is suspended between the two queries.

import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin/admin-shell";

export default async function SuperadminLayout({ children }: { children: ReactNode }) {
  const supabase = await createSupabaseServerClientReadOnly();

  // Step 1: validate JWT.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  // Step 2: atomic check — also validates status and deleted_at.
  const { data: rows, error } = await supabase.rpc("fn_assert_active_admin");

  if (error || !rows || rows.length === 0) {
    redirect(error?.code === "P0002" ? "/chat" : "/sign-in");
  }

  const profile = rows[0] as {
    user_id:        string;
    is_superadmin:  boolean;
    institution_id: string | null;
  };

  // /superadmin requires is_superadmin — admins without the flag go to /admin.
  if (!profile.is_superadmin) redirect("/admin");

  // Fetch display name.
  const { data: nameRow } = await supabase
    .from("users")
    .select("first_name")
    .eq("auth_id", user.id)
    .maybeSingle();

  return (
    <AdminShell
      tier="superadmin"
      userName={nameRow?.first_name ?? "Admin"}
      isSuperadmin={true}
    >
      {children}
    </AdminShell>
  );
}