"use client";

// Dedicated presentation for claimStatusTool — replaces the generic
// ToolFallback JSON dump with a clean status card, matching the same
// icon/color conventions already used on the claim detail page
// (app/claims/[id]/page.tsx): CheckCircle2Icon/text-success for approved,
// XCircleIcon/text-destructive for rejected, ClockIcon/muted otherwise.

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { CheckCircle2Icon, XCircleIcon, ClockIcon, AlertTriangleIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type ClaimStatusResult = {
  found?: boolean;
  claim_id?: string;
  claim_type?: string;
  status?: string;
  submitted_at?: string;
  reviewed_at?: string;
  department?: string;
  reviewer?: string;
  review_notes?: string;
  rejection_reason?: string;
  is_urgent?: boolean;
  message?: string;
};

function formatDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function statusLabel(status?: string): string {
  switch (status) {
    case "approved":  return "Approved";
    case "rejected":  return "Rejected";
    case "in_review": return "Under Review";
    case "pending":   return "Pending";
    default:          return status ?? "Unknown";
  }
}

function Row({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

export const ClaimStatusCard: ToolCallMessagePartComponent = ({ result }) => {
  const data = result as ClaimStatusResult | undefined;
  if (!data) return null;

  if (!data.found) {
    return (
      <div className="my-2 flex items-start gap-2.5 rounded-xl border border-border bg-muted/30 px-3.5 py-3 text-sm">
        <AlertTriangleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-muted-foreground">{data.message ?? "No claim found."}</p>
      </div>
    );
  }

  const Icon =
    data.status === "approved" ? CheckCircle2Icon :
    data.status === "rejected" ? XCircleIcon :
    ClockIcon;

  const iconClass =
    data.status === "approved" ? "text-success" :
    data.status === "rejected" ? "text-destructive" :
    "text-muted-foreground";

  const note = data.status === "rejected" ? data.rejection_reason : data.review_notes;

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5">
        <Icon aria-hidden className={cn("size-4 shrink-0", iconClass)} />
        <span className="text-sm font-semibold text-foreground">{statusLabel(data.status)}</span>
        {data.is_urgent && (
          <span className="ml-auto rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
            Urgent
          </span>
        )}
      </div>
      <div className="space-y-1.5 px-3.5 py-3 text-sm">
        <Row label="Claim type" value={data.claim_type} />
        <Row label="Department" value={data.department} />
        <Row label="Submitted"  value={formatDate(data.submitted_at)} />
        <Row label="Reviewed"   value={formatDate(data.reviewed_at)} />
        <Row label="Reviewer"   value={data.reviewer} />
      </div>
      {note && (
        <div className="border-t border-border px-3.5 py-2.5 text-xs text-muted-foreground">
          {note}
        </div>
      )}
    </div>
  );
};
ClaimStatusCard.displayName = "ClaimStatusCard";
