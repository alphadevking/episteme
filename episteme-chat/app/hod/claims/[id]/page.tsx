// app/hod/claims/[id]/page.tsx
// HOD claim detail — read claim data + approve/reject via ClaimReviewPanel.
// RLS (hod_select_dept_claims) ensures HOD can only fetch claims assigned to them.
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { notFound, redirect } from "next/navigation";
import { DetailShell } from "@/components/admin/detail-shell";
import { StatusBadge } from "@/components/admin/status-badge";
import { ClaimReviewPanel } from "@/components/admin/claim-review-panel";

type Params = { params: Promise<{ id: string }> };

export default async function HodClaimDetailPage({ params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClientReadOnly();

  // Guard — also gives us department context
  const { data: ctxRows, error: ctxErr } = await supabase.rpc("fn_assert_active_hod");
  if (ctxErr || !ctxRows?.length) redirect("/sign-in");

  const { data: claim } = await supabase
    .from("verification_claims")
    .select(`
      *,
      user:user_id(email, first_name, last_name)
    `)
    .eq("id", id)
    .maybeSingle();

  if (!claim) notFound();

  const user = (Array.isArray(claim.user) ? claim.user[0] : claim.user) as
    | { email: string; first_name: string | null; last_name: string | null } | null;

  const userName =
    [user?.first_name, user?.last_name].filter(Boolean).join(" ") ||
    user?.email || "Unknown";

  const canReview = claim.status === "in_review";

  return (
    <DetailShell
      backHref="/hod/claims"
      backLabel="Claims queue"
      title={`${claim.claim_type.replace(/_/g, " ")} — ${userName}`}
      subtitle={`Submitted ${new Date(claim.created_at).toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric",
      })}`}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Claim meta */}
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold">Claim Details</h2>
          <dl className="divide-y text-sm">
            {[
              { label: "Type",      value: <span className="capitalize">{claim.claim_type.replace(/_/g, " ")}</span> },
              { label: "Status",    value: <StatusBadge value={claim.status} /> },
              { label: "Urgent",    value: claim.is_urgent ? "Yes — priority review" : "No" },
              { label: "Deadline",  value: claim.deadline ? new Date(claim.deadline).toLocaleDateString() : "—" },
              { label: "Submitted", value: new Date(claim.created_at).toLocaleDateString() },
              { label: "Student",   value: userName },
              { label: "Routing",   value: claim.auto_routed ? "Auto-routed" : "Manual assignment" },
            ].map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between py-2.5">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium text-right">{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Right column */}
        <div className="space-y-4">

          {/* Submitted details */}
          {Object.keys(claim.details ?? {}).length > 0 && (
            <div className="rounded-lg border bg-card p-5 space-y-2">
              <h2 className="text-sm font-semibold">Submitted Details</h2>
              <dl className="divide-y text-sm">
                {Object.entries(claim.details as Record<string, string>).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between py-2">
                    <dt className="text-muted-foreground capitalize">{k.replace(/_/g, " ")}</dt>
                    <dd className="font-medium">{v || "—"}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* Review notes (post-decision) */}
          {claim.review_notes && (
            <div className="rounded-lg border bg-card p-5 space-y-2">
              <h2 className="text-sm font-semibold">Review Notes</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{claim.review_notes}</p>
            </div>
          )}

          {/* Rejection reason */}
          {claim.rejection_reason && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-5 space-y-2">
              <h2 className="text-sm font-semibold text-destructive">Rejection Reason</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{claim.rejection_reason}</p>
            </div>
          )}

          {/* Review panel — in_review only */}
          {canReview && <ClaimReviewPanel claimId={claim.id} />}

          {/* Already decided */}
          {!canReview && claim.status !== "pending" && (
            <div className="rounded-lg border bg-muted/30 p-5">
              <p className="text-sm text-muted-foreground">
                This claim has been <span className="font-medium text-foreground capitalize">{claim.status}</span>.
                {" "}Contact an admin to reopen it if needed.
              </p>
            </div>
          )}

          {/* Pending — waiting for admin to formally assign */}
          {claim.status === "pending" && (
            <div className="rounded-lg border bg-muted/30 p-5">
              <p className="text-sm text-muted-foreground">
                This claim is visible to your department but has not been formally assigned
                for review yet. An admin will move it to <span className="font-medium">In Review</span>.
              </p>
            </div>
          )}
        </div>
      </div>
    </DetailShell>
  );
}
