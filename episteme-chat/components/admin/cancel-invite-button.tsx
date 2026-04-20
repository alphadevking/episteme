// components/admin/cancel-invite-button.tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Trash2Icon, Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export function CancelInviteButton({ inviteId }: { inviteId: string }) {
  const router  = useRouter();
  const [busy, setBusy] = useState(false);

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    const res = await fetch(`/api/admin/invite-staff/${inviteId}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) {
      toast.success("Invite cancelled.");
      router.refresh();
    } else {
      const json = await res.json().catch(() => ({}));
      toast.error(json.error ?? "Failed to cancel invite.");
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
      onClick={cancel}
      disabled={busy}
    >
      {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <Trash2Icon className="size-3.5" />}
      Cancel
    </Button>
  );
}
