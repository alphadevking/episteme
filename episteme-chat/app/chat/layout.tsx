// app/chat/layout.tsx
// Single EpistemeRuntimeProvider for all /chat routes.
// Auth guard lives here server-side.
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { EpistemeRuntimeProvider } from "@/app/episteme-runtime";
import { getAuthContext } from "@/lib/supabase/server-auth";
import { UserSeedProvider } from "@/lib/hooks/user-context";
import { buildUserInfo } from "@/lib/user-info";

export default async function ChatLayout({ children }: { children: ReactNode }) {
  // Request-scoped and deduped: the pages below re-read the same user/profile
  // without issuing another auth call or `users` select.
  const { user, profile } = await getAuthContext();

  if (!user) redirect("/sign-in");
  if (!profile || profile.status !== "active") redirect("/onboarding");

  // Superadmins are platform-wide — they have no institution_id and don't need one.
  // All other users must have completed onboarding before accessing chat.
  if (!profile.is_superadmin && !profile.institution_id) {
    redirect("/onboarding");
  }

  // Seed the client `useUser()` with what we already resolved here, so the
  // sidebar (badge, banners, thread list) doesn't re-derive it over the network
  // before it can render.
  const seed = { user: buildUserInfo(user, profile) };

  // No threadId here — ThreadSwitcher in each page handles activation
  return (
    <UserSeedProvider seed={seed}>
      <EpistemeRuntimeProvider>{children}</EpistemeRuntimeProvider>
    </UserSeedProvider>
  );
}
