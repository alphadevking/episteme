// app/chat/layout.tsx
// Single EpistemeRuntimeProvider for all /chat routes.
// Auth guard lives here server-side.
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { EpistemeRuntimeProvider } from "@/app/episteme-runtime";

export default async function ChatLayout({ children }: { children: ReactNode }) {
  const supabase = await createSupabaseServerClientReadOnly();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("users")
    .select("status, institution_id, is_superadmin")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!profile || profile.status !== "active") redirect("/onboarding");

  // Superadmins are platform-wide — they have no institution_id and don't need one.
  // All other users must have completed onboarding before accessing chat.
  if (!(profile.is_superadmin as boolean) && !profile.institution_id) {
    redirect("/onboarding");
  }

  // No threadId here — ThreadSwitcher in each page handles activation
  return <EpistemeRuntimeProvider>{children}</EpistemeRuntimeProvider>;
}