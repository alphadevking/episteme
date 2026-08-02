// app/claims/[id]/page.tsx
// User claim detail view.
// Shows claim status, details, and (for HOD reviewers) the review panel.
import { getAuthContext, getServerSupabase } from "@/lib/supabase/server-auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/admin/status-badge";
import { ClaimReviewPanel } from "@/components/admin/claim-review-panel";
import { ChevronLeftIcon, ClockIcon, CheckCircle2Icon, XCircleIcon } from "lucide-react";

type Params = { params: Promise<{ id: string }> };

const CLAIM_LABELS: Record<string, string> = {
  transcript:    "Academic Transcript",
  degree:        "Degree Certificate",
  enrollment:    "Enrollment Letter",
  good_standing: "Good Standing Letter",
  attestation:   "Letter of Attestation",
};

export default async function ClaimDetailPage({ params }: Params) {
  const { id } = await params;
  // Request-cached — reuses the claims layout's auth call and profile row.
  const [supabase, { user, profile }] = await Promise.all([
    getServerSupabase(),
    getAuthContext(),
  ]);

  if (!user)    notFound();
  if (!profile) notFound();

  const isHod = (profile.roles as string[])?.includes("hod");

  // This query respects RLS: returns if user submitted it OR is assigned HOD
  const { data: claim } = await supabase
    .from("verification_claims")
    .select(`
      *,
      reviewer:reviewer_id(first_name, last_name, email),
      department:department_id(name)
    `)
    .eq("id", id)
    .maybeSingle();

  if (!claim) notFound();

  const reviewer = (Array.isArray(claim.reviewer) ? claim.reviewer[0] : claim.reviewer) as
    | { first_name: string | null; last_name: string | null; email: string } | null;
  const department = (Array.isArray(claim.department) ? claim.department[0] : claim.department) as
    | { name: string } | null;

  const reviewerName = reviewer
    ? [reviewer.first_name, reviewer.last_name].filter(Boolean).join(" ") || reviewer.email
    : null;

  // HOD can review only if: they are the assigned reviewer AND claim is in_review
  const canReview =
    isHod &&
    claim.status === "in_review" &&
    claim.assigned_to === profile.id;

  // This claim belongs to the user (not HOD inbox)
  const isOwn = claim.user_id === profile.id;

  // Status icon
  const StatusIcon =
    claim.status === "approved" ? CheckCircle2Icon :
    claim.status === "rejected" ? XCircleIcon :
    ClockIcon;

  const statusIconClass =
    claim.status === "approved" ? "text-success" :
    claim.status === "rejected" ? "text-destructive" :
    "text-muted-foreground";

  return (
    <div className="space-y-6">

      {/* Back */}
      <Link
        href="/claims"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronLeftIcon className="size-3.5" />
        {isOwn ? "My claims" : "Review inbox"}
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-xl font-semibold">
            {CLAIM_LABELS[claim.claim_type] ?? claim.claim_type}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Submitted {new Date(claim.created_at).toLocaleDateString("en-US", {
              year: "numeric", month: "long", day: "numeric",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {claim.is_urgent && <span className="text-sm">🔴</span>}
          <StatusBadge value={claim.status} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* ── Status timeline ── */}
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold">Status</h2>

          <div className="space-y-3">
            {[
              {
                step:    "Submitted",
                done:    true,
                date:    claim.created_at,
                note:    null,
              },
              {
                step:    "Under Review",
                done:    ["in_review", "approved", "rejected"].includes(claim.status),
                date:    claim.assigned_at,
                note:    department?.name ? `Assigned to ${department.name}` : null,
              },
              {
                step:    "Decision",
                done:    ["approved", "rejected"].includes(claim.status),
                date:    claim.reviewed_at,
                note:    reviewerName ? `By ${reviewerName}` : null,
              },
            ].map(({ step, done, date, note }) => (
              <div key={step} className="flex items-start gap-3">
                <div className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2",
                  done
                    ? "border-primary bg-primary"
                    : "border-muted-foreground/30",
                )}>
                  {done && <span className="size-2 rounded-full bg-white" />}
                </div>
                <div>
                  <p className={cn("text-sm font-medium", !done && "text-muted-foreground")}>
                    {step}
                  </p>
                  {done && date && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(date).toLocaleDateString("en-US", {
                        month: "short", day: "numeric", year: "numeric",
                      })}
                      {note && <> · {note}</>}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Outcome message */}
          {(claim.status === "approved" || claim.status === "rejected") && (
            <div className={cn(
              "flex items-start gap-2.5 rounded-lg p-3 mt-2",
              claim.status === "approved"
                ? "bg-success-bg dark:bg-success-bg border border-success/30 dark:border-success/50"
                : "bg-destructive/5 border border-destructive/20",
            )}>
              <StatusIcon className={cn("size-4 shrink-0 mt-0.5", statusIconClass)} />
              <div className="space-y-1">
                <p className={cn("text-sm font-medium", statusIconClass)}>
                  {claim.status === "approved" ? "Claim approved" : "Claim rejected"}
                </p>
                {claim.review_notes && (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {claim.review_notes}
                  </p>
                )}
                {claim.rejection_reason && (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {claim.rejection_reason}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Right column ── */}
        <div className="space-y-4">

          {/* Submitted details */}
          {Object.keys(claim.details ?? {}).length > 0 && (
            <div className="rounded-lg border bg-card p-5 space-y-3">
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

          {/* Deadline */}
          {claim.deadline && (
            <div className="flex items-center gap-2.5 rounded-lg border bg-card px-4 py-3">
              <ClockIcon className="size-3.5 text-muted-foreground shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">Requested by</p>
                <p className="text-sm font-medium">
                  {new Date(claim.deadline).toLocaleDateString("en-US", {
                    weekday: "long", month: "long", day: "numeric", year: "numeric",
                  })}
                </p>
              </div>
            </div>
          )}

          {/* HOD review panel */}
          {canReview && <ClaimReviewPanel claimId={claim.id} />}

          {/* Pending message for user */}
          {isOwn && claim.status === "pending" && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-1">
              <p className="text-sm font-medium">Awaiting assignment</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Your claim has been submitted and is waiting to be assigned to a department for review.
                You will be notified once a decision is made.
              </p>
            </div>
          )}

          {isOwn && claim.status === "in_review" && !canReview && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-1">
              <p className="text-sm font-medium">Under department review</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {department?.name
                  ? `Your claim has been assigned to ${department.name} for review.`
                  : "Your claim is being reviewed by a department head."}
                {" "}You will be notified once a decision is made.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

