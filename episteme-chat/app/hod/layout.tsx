// app/hod/layout.tsx
// HOD layout guard — mirrors app/admin/layout.tsx exactly.
// Uses fn_assert_active_hod() — single atomic SECURITY DEFINER call that
// checks role, status, deleted_at, department active, institution active.
// Raises P0001 (session/profile issue) or P0002 (not HOD).

import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { HodShell } from "@/components/hod/hod-shell";

type Props = { children: ReactNode };

export default async function HodLayout({ children }: Props) {
  const supabase = await createSupabaseServerClientReadOnly();

  // Step 1: validate JWT
  const { data: { user: authUser } } = await supabase.auth.getUser();
  if (!authUser) redirect("/sign-in");

  // Step 2: atomic role + status + department check
  const { data: rows, error } = await supabase.rpc("fn_assert_active_hod");

  if (error || !rows || rows.length === 0) {
    // P0002 = authenticated but not an HOD → send to chat
    // P0001 / anything else = session issue → sign-in
    redirect(error?.code === "P0002" ? "/chat" : "/sign-in");
  }

  const ctx = rows[0] as {
    user_id:         string;
    department_id:   string;
    department_name: string;
    faculty_id:      string;
    institution_id:  string;
  };

  // HOD with no department shouldn't exist (fn_assert_active_hod enforces it)
  // but guard here too for defence in depth
  if (!ctx.department_id) redirect("/chat");

  const { data: nameRow } = await supabase
    .from("users")
    .select("first_name")
    .eq("auth_id", authUser.id)
    .maybeSingle();

  return (
    <HodShell
      departmentName={ctx.department_name}
      userName={nameRow?.first_name ?? "HOD"}
    >
      {children}
    </HodShell>
  );
}
