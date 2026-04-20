// app/admin/layout.tsx
// Layouts cannot read searchParams in Next.js App Router.
// This layout only handles auth + role guarding.
// Institution resolution happens in each page component via requireAdminAccess().
//
// Uses fn_assert_active_admin() — a single atomic SECURITY DEFINER call —
// instead of a two-step auth.getUser() + profile SELECT, which is vulnerable
// to TOCTOU (role revocation between the two queries).

import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin/admin-shell";

type Props = { children: ReactNode };

export default async function AdminLayout({ children }: Props) {
  const supabase = await createSupabaseServerClientReadOnly();

  // Step 1: validate JWT — must happen before any RPC call.
  const { data: { user: authUser } } = await supabase.auth.getUser();
  if (!authUser) redirect("/sign-in");

  // Step 2: atomic role + status check via SECURITY DEFINER function.
  // Raises P0001 (not found / inactive) or P0002 (not admin/superadmin).
  const { data: rows, error } = await supabase.rpc("fn_assert_active_admin");

  if (error || !rows || rows.length === 0) {
    // P0002 = authenticated but not an admin → send to chat
    // P0001 / anything else → session issue → sign-in
    redirect(error?.code === "P0002" ? "/chat" : "/sign-in");
  }

  const profile = rows[0] as {
    user_id:        string;
    is_superadmin:  boolean;
    institution_id: string | null;
  };

  const isSuperadmin = profile.is_superadmin === true;

  // Regular admins without an institution haven't completed onboarding.
  if (!isSuperadmin && !profile.institution_id) redirect("/onboarding");

  // Fetch display name separately — fn_assert_active_admin doesn't return it.
  const { data: nameRow } = await supabase
    .from("users")
    .select("first_name")
    .eq("auth_id", authUser.id)
    .maybeSingle();

  return (
    <AdminShell
      tier="admin"
      userName={nameRow?.first_name ?? "Admin"}
      isSuperadmin={isSuperadmin}
    >
      {children}
    </AdminShell>
  );
}