// components/admin/claim-review-panel.tsx
// HOD review panel — approve or reject a claim via fn_hod_review_claim.
// Rendered in the user-facing /claims/[id] page when the HOD is the assigned reviewer.
"use client";

import { Button } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

type Props = { claimId: string };

export function ClaimReviewPanel({ claimId }: Props) {
  const supabase    = createSupabaseBrowserClient();
  const router      = useRouter();
  const [notes,     setNotes]     = useState("");
  const [rejection, setRejection] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [saving,    setSaving]    = useState(false);

  const review = async (action: "approve" | "reject") => {
    if (action === "reject" && !rejection.trim()) return;
    setSaving(true);

    const { error } = await supabase.rpc("fn_hod_review_claim", {
      p_claim_id:         claimId,
      p_action:           action,
      p_notes:            notes.trim() || undefined,
      p_rejection_reason: action === "reject" ? rejection.trim() : undefined,
    });

    setSaving(false);
    if (error) { toast.error(error.message); return; }

    toast.success(action === "approve" ? "Claim approved." : "Claim rejected.");
    router.refresh();
  };

  return (
    <div className="rounded-lg border bg-card p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Your Review</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          This claim has been assigned to your department for review.
        </p>
      </div>

      {/* Notes */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Review notes (optional)
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Add notes about this claim…"
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm resize-none outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 placeholder:text-muted-foreground/60"
        />
      </div>

      {/* Rejection reason */}
      {showReject && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium uppercase tracking-wide text-destructive">
            Rejection reason *
          </label>
          <textarea
            value={rejection}
            onChange={(e) => setRejection(e.target.value)}
            rows={3}
            placeholder="Explain why this claim is being rejected…"
            className="w-full rounded border border-destructive/40 bg-background px-3 py-2 text-sm resize-none outline-none focus:border-destructive focus:ring-2 focus:ring-destructive/15 placeholder:text-muted-foreground/60"
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={saving}
          onClick={() => review("approve")}
          className="bg-success hover:bg-success/90 text-white"
        >
          {saving ? "Saving…" : "Approve"}
        </Button>

        {showReject ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              disabled={saving || !rejection.trim()}
              onClick={() => review("reject")}
            >
              {saving ? "Rejecting…" : "Confirm Reject"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setShowReject(false); setRejection(""); }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="border-destructive/30 text-destructive hover:bg-destructive/5"
            onClick={() => setShowReject(true)}
          >
            Reject…
          </Button>
        )}
      </div>
    </div>
  );
}
