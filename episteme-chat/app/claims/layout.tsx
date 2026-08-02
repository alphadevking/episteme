// app/claims/layout.tsx
// Auth guard + minimal shell for the user-facing claims area.
import { redirect } from "next/navigation";
import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeftIcon, FileCheckIcon } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Logo } from "@/components/logo";
import { getAuthContext } from "@/lib/supabase/server-auth";

export default async function ClaimsLayout({ children }: { children: ReactNode }) {
  // Request-cached: the pages below reuse this auth call and profile row.
  const { user, profile } = await getAuthContext();

  if (!user) redirect("/sign-in");

  if (!profile || profile.status !== "active" || !profile.institution_id) {
    redirect("/onboarding");
  }

  return (
    <div className="min-h-dvh bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-10 flex h-12 items-center justify-between border-b bg-background/90 px-4 backdrop-blur-sm">
        <Link
          href="/chat"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeftIcon className="size-3.5" />
          Chat
        </Link>

        <div className="flex items-center gap-2">
          <Logo asLink={false} width={20} height={20} />
          <FileCheckIcon className="size-3.5 text-primary" />
          <span className="font-serif text-sm font-medium">Verification Claims</span>
        </div>

        <div className="flex items-center gap-2">
          {profile.first_name && (
            <span className="hidden sm:block text-xs text-muted-foreground">
              {profile.first_name}
            </span>
          )}
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8 space-y-6">
        {children}
      </main>
    </div>
  );
}
