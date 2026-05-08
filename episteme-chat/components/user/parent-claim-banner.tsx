"use client";

// Shows a parent their pending ward link status with correct/cancel actions.
// Self-contained — fetches its own data, renders nothing if no pending claim.

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { cn } from "@/lib/utils";
import { CheckCircle2Icon, ClockIcon, XCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Claim = {
  id:                  string;
  claimed_matric:      string | null;
  verification_status: string;
  expires_at:          string | null;
};

type View = "idle" | "editing" | "saving" | "cancelling";

// Height-matched shimmer — prevents UserBadge jumping when claim resolves.
function BannerSkeleton() {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-1.5">
        <div className="size-3 rounded-full bg-muted animate-pulse shrink-0" />
        <div className="h-2.5 w-20 rounded bg-muted animate-pulse" />
        <div className="ml-auto h-4 w-16 rounded bg-muted animate-pulse" />
      </div>
      <div className="h-2.5 w-3/4 rounded bg-muted animate-pulse" />
      <div className="flex gap-1.5">
        <div className="h-6 flex-1 rounded bg-muted animate-pulse" />
        <div className="size-6 rounded bg-muted animate-pulse" />
      </div>
    </div>
  );
}

export function ParentClaimBanner() {
  const supabase          = createSupabaseBrowserClient();
  const [claim, setClaim] = useState<Claim | null | undefined>(undefined); // undefined = loading
  const [view,  setView]  = useState<View>("idle");
  const [draft, setDraft] = useState("");
  const [err,   setErr]   = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("parent_student_links")
      .select("id, claimed_matric, verification_status, expires_at")
      .in("verification_status", ["pending", "awaiting_student_approval"])
      .is("student_user_id", null)
      .maybeSingle()
      .then(({ data }) => setClaim(data ?? null));
  }, [supabase]);

  // Show height-matched shimmer while fetching — prevents footer CLS.
  if (claim === undefined) return <BannerSkeleton />;
  if (claim === null) return null;

  const isPending  = claim.verification_status === "pending";
  const isAwaiting = claim.verification_status === "awaiting_student_approval";

  const handleUpdate = async () => {
    if (!draft.trim()) return;
    setView("saving");
    setErr(null);
    const res = await fetch("/api/parent-claim", {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ newMatric: draft.trim() }),
    });
    const json = await res.json();
    if (!res.ok) { setErr(json.error); setView("editing"); return; }
    setClaim((c) => c ? { ...c, claimed_matric: json.claimedMatric } : c);
    setView("idle");
    setDraft("");
  };

  const handleCancel = async () => {
    setView("cancelling");
    await fetch("/api/parent-claim", { method: "DELETE" });
    setClaim(null);
  };

  return (
    <div className="rounded-lg border bg-card px-3 py-2.5 text-xs space-y-2">
      <div className="flex items-center gap-1.5">
        {isPending  && <ClockIcon       className="size-3 text-warning shrink-0" />}
        {isAwaiting && <CheckCircle2Icon className="size-3 text-info shrink-0" />}
        <span className="font-medium text-foreground">Ward link</span>
        <span className={cn(
          "ml-auto rounded px-1.5 py-0.5 font-medium",
          isPending  && "bg-warning-bg text-warning",
          isAwaiting && "bg-info-bg text-info",
        )}>
          {isPending  ? "Pending" : "Awaiting student"}
        </span>
      </div>

      {claim.claimed_matric && (
        <p className="text-muted-foreground">
          Matric: <span className="font-mono font-medium text-foreground">{claim.claimed_matric}</span>
        </p>
      )}

      {isAwaiting && (
        <p className="text-muted-foreground">
          Your ward&apos;s account has been found. Waiting for them to approve the link.
        </p>
      )}

      {err && <p className="text-destructive">{err}</p>}

      {view === "editing" && (
        <div className="flex gap-1.5">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Corrected matric…"
            className="h-7 text-xs"
            autoFocus
          />
          <Button size="sm" className="h-7 text-xs px-2" onClick={handleUpdate} disabled={(view as View) === "saving"}>
            Save
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={() => setView("idle")}>
            ✕
          </Button>
        </div>
      )}

      {view === "idle" && isPending && (
        <div className="flex gap-1.5">
          <Button
            size="sm" variant="outline"
            className="h-6 text-[11px] px-2 flex-1"
            onClick={() => { setDraft(claim.claimed_matric ?? ""); setView("editing"); }}
          >
            Correct matric
          </Button>
          <Button
            size="sm" variant="ghost"
            className="h-6 text-[11px] px-2 text-destructive hover:text-destructive"
            onClick={handleCancel}
            disabled={(view as View) === "cancelling"}
          >
            <XCircleIcon className="size-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
