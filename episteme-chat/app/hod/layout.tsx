// app/hod/layout.tsx
// HOD layout guard — mirrors app/admin/layout.tsx exactly.
// Uses fn_assert_active_hod() — single atomic SECURITY DEFINER call that
// checks role, status, deleted_at, department active, institution active.
// Raises P0001 (session/profile issue) or P0002 (not HOD).

import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { HodShell } from "@/components/hod/hod-shell";
import { getAuthUser, getHodAssertion, getUserProfile } from "@/lib/supabase/server-auth";

type Props = { children: ReactNode };

export default async function HodLayout({ children }: Props) {
  // Step 1: validate JWT
  const authUser = await getAuthUser();
  if (!authUser) redirect("/sign-in");

  // Step 2: atomic role + status + department check.
  // Request-cached; the pages below reuse this assertion rather than repeating it.
  const { row: ctx, error } = await getHodAssertion();

  if (error || !ctx) {
    // P0002 = authenticated but not an HOD → send to chat
    // P0001 / anything else = session issue → sign-in
    redirect(error?.code === "P0002" ? "/chat" : "/sign-in");
  }

  // HOD with no department shouldn't exist (fn_assert_active_hod enforces it)
  // but guard here too for defence in depth
  if (!ctx.department_id) redirect("/chat");

  const displayProfile = await getUserProfile();

  return (
    <HodShell
      departmentName={ctx.department_name}
      userName={displayProfile?.first_name ?? "HOD"}
    >
      {children}
    </HodShell>
  );
}
