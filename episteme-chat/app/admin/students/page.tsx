// app/admin/students/page.tsx
import { PageHeader } from "@/components/admin/page-header";
import { DataTable } from "@/components/admin/data-table";
import { FilterBar } from "@/components/admin/filter-bar";
import { requireAdminAccess } from "@/lib/admin-guard";
import { StudentVerifyActions } from "@/components/admin/student-verify-actions";

type Props = { searchParams: Promise<{ institution?: string; tab?: string; q?: string }> };

type LinkRow = {
  id:                  string;
  matric_number:       string;
  trust_level:         number;
  verification_status: string;
  rejection_reason:    string | null;
  attempt_count:       number;
  created_at:          string;
  updated_at:          string;
  user: {
    id:          string;
    first_name:  string | null;
    last_name:   string | null;
    email:       string;
  } | null;
};

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  pending:        { label: "Pending",   className: "bg-warning-bg text-warning dark:bg-warning-bg dark:text-warning" },
  admin_verified: { label: "Verified",  className: "bg-success-bg text-success dark:bg-success-bg dark:text-success" },
  rejected:       { label: "Rejected",  className: "bg-error-bg text-error dark:bg-error-bg dark:text-error" },
};

export default async function StudentsPage({ searchParams }: Props) {
  const { institution: institutionParam, tab = "pending", q } = await searchParams;
  const { supabase, institutionId } = await requireAdminAccess(institutionParam);

  const instSuffix = institutionParam ? `?institution=${institutionId}` : "";

  const statusFilter = tab === "verified" ? "admin_verified"
                     : tab === "rejected" ? "rejected"
                     : "pending";

  let query = supabase
    .from("user_student_links")
    .select("id, matric_number, trust_level, verification_status, rejection_reason, attempt_count, created_at, updated_at, user:user_id(id, first_name, last_name, email)")
    .eq("institution_id", institutionId)
    .eq("verification_status", statusFilter)
    .order("updated_at", { ascending: false });

  if (q) query = query.ilike("matric_number", `%${q}%`);

  const { data: links } = await query;

  const tabs = [
    { key: "pending",  label: "Pending"  },
    { key: "verified", label: "Verified" },
    { key: "rejected", label: "Rejected" },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Student Verification"
        description="Review and verify student matric number submissions."
      />

      {/* Tab bar */}
      <div className="flex gap-1 border-b">
        {tabs.map((t) => (
          <a
            key={t.key}
            href={`/admin/students${instSuffix}${instSuffix ? "&" : "?"}tab=${t.key}`}
            className={[
              "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
              tab === t.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {t.label}
          </a>
        ))}
      </div>

      {/* ── Filters ─────────────────────────────────────────── */}
      <FilterBar
        filters={[
          { type: "search", placeholder: "Search matric number…" },
        ]}
      />

      <DataTable<LinkRow>
        rows={(links ?? []) as unknown as LinkRow[]}
        emptyText={q ? "No students match your search." : `No ${tab} submissions.`}
        columns={[
          {
            key: "student", label: "Student",
            render: (r) => {
              const name = [r.user?.first_name, r.user?.last_name].filter(Boolean).join(" ") || "—";
              return (
                <div>
                  <p className="font-medium text-foreground">{name}</p>
                  <p className="text-xs text-muted-foreground">{r.user?.email}</p>
                </div>
              );
            },
          },
          { key: "matric_number", label: "Matric No." },
          {
            key: "verification_status", label: "Status",
            render: (r) => {
              const s = STATUS_LABELS[r.verification_status] ?? { label: r.verification_status, className: "" };
              return (
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}>
                  {s.label}
                </span>
              );
            },
          },
          {
            key: "rejection_reason", label: "Rejection Reason",
            render: (r) => r.rejection_reason
              ? <span className="text-xs text-muted-foreground italic">{r.rejection_reason}</span>
              : <span className="text-muted-foreground/40">—</span>,
          },
          {
            key: "submitted", label: "Submitted",
            render: (r) => (
              <span className="text-xs text-muted-foreground">
                {new Date(r.created_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
              </span>
            ),
          },
          {
            key: "actions", label: "", className: "w-52 text-right",
            render: (r) => (
              <StudentVerifyActions
                linkId={r.id}
                status={r.verification_status}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
