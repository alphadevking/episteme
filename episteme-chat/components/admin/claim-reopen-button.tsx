// components/admin/claim-reopen-button.tsx
// Admin resets a decided or assigned claim back to pending via fn_admin_reopen_claim.
"use client";

import { Button } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcwIcon } from "lucide-react";

type Props = { claimId: string };

export function ClaimReopenButton({ claimId }: Props) {
  const supabase     = createSupabaseBrowserClient();
  const router       = useRouter();
  const [saving,     setSaving]   = useState(false);
  const [confirming, setConfirming] = useState(false);

  const reopen = async () => {
    setSaving(true);
    const { error } = await supabase.rpc("fn_admin_reopen_claim", {
      p_claim_id: claimId,
      p_notes:    null,
    });
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Claim reopened.");
    setConfirming(false);
    router.refresh();
  };

  if (!confirming) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="text-xs"
        onClick={() => setConfirming(true)}
      >
        <RotateCcwIcon className="size-3.5 mr-1.5" />
        Reopen Claim
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Reopen this claim?</span>
      <Button size="sm" variant="destructive" disabled={saving} onClick={reopen} className="text-xs h-7">
        {saving ? "Reopening…" : "Yes, reopen"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} className="text-xs h-7">
        Cancel
      </Button>
    </div>
  );
}
