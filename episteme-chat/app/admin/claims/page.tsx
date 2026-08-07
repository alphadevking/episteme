// app/admin/claims/page.tsx
import { PageHeader } from "@/components/admin/page-header";
import { DataTable } from "@/components/admin/data-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { FilterBar } from "@/components/admin/filter-bar";
import { requireAdminAccess } from "@/lib/admin-guard";
import { asEnum } from "@/lib/types/enums";
import Link from "next/link";
import { Button } from "@/components/ui/button";

type Props = { searchParams: Promise<{ institution?: string; status?: string; type?: string; urgent?: string }> };

type ClaimRow = {
  id:          string;
  claim_type:  string;
  status:      string;
  is_urgent:   boolean;
  created_at:  string;
  users:        { email: string; first_name: string | null } | null;
  assigned_hod: { first_name: string | null; email: string } | null;
  department:   { name: string } | null;
};

const CLAIM_TYPE_OPTIONS = [
  { value: "transcript",  label: "Transcript"  },
  { value: "degree",      label: "Degree"      },
  { value: "enrollment",  label: "Enrollment"  },
];

const URGENT_OPTIONS = [
  { value: "true",  label: "Urgent only" },
  { value: "false", label: "Non-urgent"  },
];

export default async function ClaimsPage({ searchParams }: Props) {
  const { institution: institutionParam, status: statusFilter, type: typeFilter, urgent: urgentFilter } = await searchParams;
  const { supabase, institutionId } = await requireAdminAccess(institutionParam);

  let query = supabase
    .from("verification_claims")
    .select(`
      id, claim_type, status, is_urgent, created_at,
      users:user_id(email, first_name),
      assigned_hod:assigned_to(first_name, email),
      department:department_id(name)
    `)
    .eq("institution_id", institutionId)
    .order("is_urgent", { ascending: false })
    .order("created_at", { ascending: false });

  // Narrowed against the generated enum values — an unrecognised query param is
  // dropped rather than passed to PostgREST, which would reject the whole query
  // with 22P02 and render an empty list with no explanation.
  const status = asEnum("claim_status", statusFilter);
  const type   = asEnum("claim_type",   typeFilter);

  if (status)                     query = query.eq("status", status);
  if (type)                       query = query.eq("claim_type", type);
  if (urgentFilter === "true")    query = query.eq("is_urgent", true);
  if (urgentFilter === "false")   query = query.eq("is_urgent", false);

  const { data: claims } = await query;

  const instSuffix = institutionParam ? `?institution=${institutionId}` : "";

  const STATUSES = ["pending", "in_review", "approved", "rejected", "cancelled"];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Verification Claims"
        description="Review transcript, degree, and enrollment requests."
      />

      {/* Status filter tabs */}
      <div className="flex flex-wrap gap-1.5">
        <Link href={`/admin/claims${instSuffix}`}>
          <Button
            size="sm"
            variant={!statusFilter ? "default" : "outline"}
            className="h-7 text-xs"
          >
            All
          </Button>
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/admin/claims${instSuffix ? instSuffix + "&" : "?"}status=${s}`}
          >
            <Button
              size="sm"
              variant={statusFilter === s ? "default" : "outline"}
              className="h-7 text-xs capitalize"
            >
              {s.replace(/_/g, " ")}
            </Button>
          </Link>
        ))}
      </div>

      {/* ── Filters ─────────────────────────────────────────── */}
      <FilterBar
        filters={[
          { type: "select", key: "type",   label: "Type",    all: "All types",    options: CLAIM_TYPE_OPTIONS },
          { type: "select", key: "urgent", label: "Urgency", all: "All urgency",  options: URGENT_OPTIONS     },
        ]}
      />

      <DataTable<ClaimRow>
        rows={(claims ?? []) as unknown as ClaimRow[]}
        emptyText="No claims found."
        columns={[
          {
            key: "user",
            label: "Requester",
            render: (r) => {
              const u = Array.isArray(r.users) ? r.users[0] : r.users;
              return u?.first_name ? `${u.first_name} (${u.email})` : (u?.email ?? "—");
            },
          },
          { key: "claim_type", label: "Type", className: "capitalize",
            render: (r) => r.claim_type.replace(/_/g, " ") },
          { key: "status", label: "Status",
            render: (r) => <StatusBadge value={r.status} /> },
          {
            key: "assigned_hod",
            label: "Assigned HOD",
            render: (r) => {
              const hod = Array.isArray(r.assigned_hod) ? r.assigned_hod[0] : r.assigned_hod;
              const dept = Array.isArray(r.department) ? r.department[0] : r.department;
              if (!hod) return <span className="text-muted-foreground">—</span>;
              return (
                <span className="text-xs">
                  {hod.first_name || hod.email}
                  {dept?.name && (
                    <span className="text-muted-foreground"> / {dept.name}</span>
                  )}
                </span>
              );
            },
          },
          { key: "is_urgent", label: "Urgent",
            render: (r) => r.is_urgent ? "🔴 Yes" : "—" },
          {
            key: "created_at",
            label: "Submitted",
            render: (r) =>
              new Date(r.created_at).toLocaleDateString("en-US", {
                year: "numeric", month: "short", day: "numeric",
              }),
            className: "text-xs text-muted-foreground",
          },
          {
            key: "actions",
            label: "",
            className: "w-20 text-right",
            render: (r) => (
              <Link href={`/admin/claims/${r.id}${instSuffix}`}>
                <Button variant="ghost" size="sm" className="h-7 text-xs">
                  {r.status === "pending" ? "Assign" : "View"}
                </Button>
              </Link>
            ),
          },
        ]}
      />
    </div>
  );
}
