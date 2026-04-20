"use client";

// components/admin/student-verify-actions.tsx
// Verify / Reject buttons for a student link row in /admin/students.
// Reject opens an inline reason input before confirming.

import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  linkId: string;
  status: string;
};

export function StudentVerifyActions({ linkId, status }: Props) {
  const router = useRouter();
  const [saving,         setSaving]         = useState(false);
  const [rejectOpen,     setRejectOpen]     = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");

  const call = async (action: "verify" | "reject", reason?: string) => {
    setSaving(true);
    await fetch("/api/admin/verify-student", {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ linkId, action, reason }),
    });
    setSaving(false);
    setRejectOpen(false);
    setRejectionReason("");
    router.refresh();
  };

  if (status === "admin_verified") {
    return <span className="text-xs text-muted-foreground">Verified</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {!rejectOpen ? (
        <div className="flex items-center gap-1.5">
          {status !== "admin_verified" && (
            <Button
              size="sm"
              disabled={saving}
              onClick={() => call("verify")}
              className="h-7 text-xs bg-success hover:bg-success/90"
            >
              Verify
            </Button>
          )}
          {status !== "rejected" && (
            <Button
              size="sm"
              variant="destructive"
              disabled={saving}
              onClick={() => setRejectOpen(true)}
              className="h-7 text-xs"
            >
              Reject
            </Button>
          )}
          {status === "rejected" && (
            <Button
              size="sm"
              disabled={saving}
              onClick={() => call("verify")}
              className="h-7 text-xs bg-success hover:bg-success/90"
            >
              Verify anyway
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-end gap-1.5 w-full max-w-xs">
          <input
            autoFocus
            className="w-full rounded-md border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Reason for rejection…"
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && rejectionReason.trim()) call("reject", rejectionReason);
              if (e.key === "Escape") setRejectOpen(false);
            }}
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => setRejectOpen(false)}
              className="h-6 text-[11px] px-2"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={saving || !rejectionReason.trim()}
              onClick={() => call("reject", rejectionReason)}
              className="h-6 text-[11px] px-2"
            >
              Confirm
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
