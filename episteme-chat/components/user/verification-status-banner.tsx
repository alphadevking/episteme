"use client";

// components/user/verification-status-banner.tsx
// Shows student students their matric verification status in the chat sidebar.
// - pending:        "Awaiting admin review" (passive, no action)
// - rejected:       Shows rejection reason + "Re-submit" button
// - admin_verified: Renders nothing (no noise after success)
// Only renders for primary_role = 'prospective' | 'student' and non-superadmin users.

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { ClockIcon, XCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useUser } from "@/lib/hooks/use-user";

type LinkStatus = {
  verification_status: "pending" | "admin_verified" | "rejected";
  rejection_reason: string | null;
  matric_number: string;
};

const STUDENT_ROLES = ["prospective", "student"];

// Compact shimmer that matches the card height so there's no layout shift
// when the real content appears or when nothing renders.
function BannerSkeleton() {
  return (
    // space-y-1.5 matches both card states; includes a button row to cover
    // the rejected state (tallest variant) so content never shifts upward.
    <div className="rounded-lg border bg-card px-3 py-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="size-3 rounded-full bg-muted animate-pulse shrink-0" />
        <div className="h-3 w-28 rounded bg-muted animate-pulse" />
      </div>
      <div className="h-3 w-full rounded bg-muted animate-pulse" />
      <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
      <div className="h-6 w-full rounded bg-muted animate-pulse" />
    </div>
  );
}

export function VerificationStatusBanner() {
  // Share the user/role fetch with UserBadge — avoids a duplicate auth.getUser() call.
  const { user, loading: userLoading } = useUser();
  const router = useRouter();
  const [link, setLink] = useState<LinkStatus | null | undefined>(undefined);

  const isStudentRole = STUDENT_ROLES.includes(user?.primary_role ?? "");
  // Definitively irrelevant once we know the user and their role.
  const isIrrelevant = !userLoading && (!user || !isStudentRole);

  useEffect(() => {
    if (userLoading) return;
    if (isIrrelevant) { setLink(null); return; }

    createSupabaseBrowserClient()
      .from("user_student_links")
      .select("verification_status, rejection_reason, matric_number")
      .maybeSingle()
      .then(({ data }) => setLink((data as LinkStatus) ?? null));
  }, [userLoading, isIrrelevant]);

  // Definitely not relevant — render nothing, no flicker.
  if (isIrrelevant) return null;
  // No link record at all, or already verified — silent.
  if (!userLoading && (link === null || link?.verification_status === "admin_verified")) return null;

  // Show shimmer while user data or link data is in-flight.
  // Height-matched so UserBadge doesn't jump when content resolves.
  if (userLoading || link === undefined) return <BannerSkeleton />;

  if (link?.verification_status === "pending") {
    return (
      <div className="rounded-lg border bg-card px-3 py-2.5 text-xs space-y-1.5">
        <div className="flex items-center gap-1.5">
          <ClockIcon className="size-3 text-warning shrink-0" />
          <span className="font-medium text-foreground">Verification pending</span>
        </div>
        <p className="text-muted-foreground leading-snug">
          Your matric number <span className="font-mono font-medium text-foreground">{link.matric_number}</span> is
          awaiting review by your institution admin.
        </p>
      </div>
    );
  }

  // Rejected
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs space-y-1.5">
      <div className="flex items-center gap-1.5">
        <XCircleIcon className="size-3 text-destructive shrink-0" />
        <span className="font-medium text-foreground">Verification rejected</span>
      </div>
      {link?.rejection_reason && (
        <p className="text-muted-foreground leading-snug italic">{link.rejection_reason}</p>
      )}
      <Button
        size="sm"
        variant="outline"
        className="h-6 text-[11px] px-2 w-full"
        onClick={() => router.push("/onboarding")}
      >
        Re-submit matric
      </Button>
    </div>
  );
}
