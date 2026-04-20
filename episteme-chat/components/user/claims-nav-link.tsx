// components/user/claims-nav-link.tsx
// Shows a "Verification Claims" sidebar link for roles that can submit or review claims.
// Student students + HODs see it. Staff/prospective/parent do not.
"use client";

import Link from "next/link";
import { FileCheckIcon, InboxIcon } from "lucide-react";
import { useUser } from "@/lib/hooks/use-user";
import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function ClaimsNavLink() {
  const { user, loading } = useUser();
  const [hodPending, setHodPending] = useState(0);

  const isHod = user?.roles?.includes("hod") ?? false;
  const isStudent = user?.primary_role === "student";
  const showLink = isHod || isStudent;

  useEffect(() => {
    if (!isHod || !user?.id) return;
    const supabase = createSupabaseBrowserClient();

    supabase
      .from("users")
      .select("id")
      .eq("auth_id", user.id)
      .maybeSingle()
      .then(({ data: profile }) => {
        if (!profile) return;
        supabase
          .from("verification_claims")
          .select("id", { count: "exact", head: true })
          .eq("assigned_to", profile.id)
          .eq("status", "in_review")
          .then(({ count }) => setHodPending(count ?? 0));
      });
  }, [isHod, user?.id]);

  if (loading || !showLink) return null;

  return (
    <Link
      href="/claims"
      className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors"
    >
      <span className="flex items-center gap-2">
        {isHod ? (
          <InboxIcon className="size-3.5 shrink-0" />
        ) : (
          <FileCheckIcon className="size-3.5 shrink-0" />
        )}
        {isHod ? "Review Inbox" : "Verification Claims"}
      </span>
      {isHod && hodPending > 0 && (
        <span className="inline-flex items-center rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
          {hodPending}
        </span>
      )}
    </Link>
  );
}
