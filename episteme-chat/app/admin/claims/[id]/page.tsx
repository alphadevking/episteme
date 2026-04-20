// app/admin/claims/[id]/page.tsx
// Admin claim detail — assign (pending) or reopen (in_review / decided).
// HOD review happens on the user-facing /claims/[id] page.
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { DetailShell } from "@/components/admin/detail-shell";
import { StatusBadge } from "@/components/admin/status-badge";
import { ClaimAssignPanel } from "@/components/admin/claim-assign-panel";
import { ClaimReopenButton } from "@/components/admin/claim-reopen-button";

type Params = { params: Promise<{ id: string }> };

type HodRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
} | null;

type DeptRow = {
  id: string;
  name: string;
  hod_user_id: string | null;
  hod: HodRow;
};

export default async function ClaimDetailPage({ params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClientReadOnly();

  // ── Fetch claim with joins ──────────────────────────────────────────────────
  const { data: claim } = await supabase
    .from("verification_claims")
    .select(`
      *,
      user:user_id(email, first_name, last_name),
      reviewer:reviewer_id(email, first_name, last_name),
      assigned_hod:assigned_to(email, first_name, last_name),
      department:department_id(name)
    `)
    .eq("id", id)
    .maybeSingle();

  if (!claim) notFound();

  // Normalize FK joins (Supabase may return arrays)
  const user = (Array.isArray(claim.user) ? claim.user[0] : claim.user) as
    | { email: string; first_name: string | null; last_name: string | null } | null;
  const reviewer = (Array.isArray(claim.reviewer) ? claim.reviewer[0] : claim.reviewer) as
    | { email: string; first_name: string | null; last_name: string | null } | null;
  const assignedHod = (Array.isArray(claim.assigned_hod) ? claim.assigned_hod[0] : claim.assigned_hod) as
    | { email: string; first_name: string | null; last_name: string | null } | null;
  const department = (Array.isArray(claim.department) ? claim.department[0] : claim.department) as
    | { name: string } | null;

  const userName =
    [user?.first_name, user?.last_name].filter(Boolean).join(" ") ||
    user?.email || "Unknown";

  const reviewerName = reviewer
    ? [reviewer.first_name, reviewer.last_name].filter(Boolean).join(" ") || reviewer.email
    : null;

  const hodName = assignedHod
    ? [assignedHod.first_name, assignedHod.last_name].filter(Boolean).join(" ") || assignedHod.email
    : null;

  // ── Fetch departments + HODs (for assign panel) ─────────────────────────────
  // Only needed if the claim is still pending
  let departments: DeptRow[] = [];
  if (claim.status === "pending") {
    const { data } = await supabase
      .from("departments")
      .select("id, name, hod_user_id, hod:hod_user_id(id, first_name, last_name, email)")
      .eq("institution_id", claim.institution_id)
      .eq("is_active", true)
      .order("name");

    departments = ((data ?? []) as unknown as DeptRow[]);
  }

  const canReopen = ["in_review", "approved", "rejected"].includes(claim.status);

  return (
    <DetailShell
      backHref="/admin/claims"
      backLabel="All claims"
      title={`${claim.claim_type.replace(/_/g, " ")} — ${userName}`}
      subtitle={`Submitted ${new Date(claim.created_at).toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric",
      })}`}
      action={canReopen ? <ClaimReopenButton claimId={claim.id} /> : undefined}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* ── Claim details ── */}
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold">Claim Details</h2>
          <dl className="divide-y text-sm">
            {[
              { label: "Type",      value: <span className="capitalize">{claim.claim_type.replace(/_/g, " ")}</span> },
              { label: "Status",    value: <StatusBadge value={claim.status} /> },
              { label: "Urgent",    value: claim.is_urgent ? "Yes 🔴" : "No" },
              { label: "Deadline",  value: claim.deadline ? new Date(claim.deadline).toLocaleDateString() : "—" },
              { label: "Submitted", value: new Date(claim.created_at).toLocaleDateString() },
              { label: "Requester", value: userName },
              {
                label: "Assigned to",
                value: hodName
                  ? `${hodName}${department?.name ? ` (${department.name})` : ""}`
                  : "—",
              },
              { label: "Reviewer",  value: reviewerName ?? "—" },
              {
                label: "Reviewed",
                value: claim.reviewed_at
                  ? new Date(claim.reviewed_at).toLocaleDateString()
                  : "—",
              },
            ].map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between py-2.5">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium text-right">{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* ── Right column ── */}
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

          {/* Review notes */}
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

          {/* Assign panel — pending only */}
          {claim.status === "pending" && (
            <ClaimAssignPanel claimId={claim.id} departments={departments} />
          )}

          {/* Awaiting HOD review — in_review */}
          {claim.status === "in_review" && (
            <div className="rounded-lg border bg-muted/30 p-5 space-y-1.5">
              <h2 className="text-sm font-semibold">Awaiting HOD Review</h2>
              <p className="text-sm text-muted-foreground">
                Assigned to{" "}
                <span className="font-medium text-foreground">
                  {hodName ?? "HOD"}
                </span>
                {department?.name && ` — ${department.name}`}. The HOD will approve or reject this
                claim from their review inbox.
              </p>
            </div>
          )}
        </div>
      </div>
    </DetailShell>
  );
}
