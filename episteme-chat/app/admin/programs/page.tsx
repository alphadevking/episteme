// app/admin/programs/page.tsx
import { PageHeader } from "@/components/admin/page-header";
import { DataTable } from "@/components/admin/data-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { CrudDialog } from "@/components/admin/crud-dialog";
import { FilterBar } from "@/components/admin/filter-bar";
import { requireAdminAccess } from "@/lib/admin-guard";
import Link from "next/link";
import { Button } from "@/components/ui/button";

type Props = { searchParams: Promise<{ institution?: string; q?: string; status?: string; degree?: string; department?: string }> };
type Program = { id: string; name: string; code: string; degree_type: string; duration_years: number | null; is_active: boolean; departments: { name: string } | null };

const DEGREE_TYPES = ["Bachelor","Master","PhD","Diploma","Certificate"].map((d) => ({ value: d, label: d }));

const STATUS_OPTIONS = [
  { value: "active",   label: "Active"   },
  { value: "inactive", label: "Inactive" },
];

export default async function ProgramsPage({ searchParams }: Props) {
  const { institution: institutionParam, q, status, degree, department: deptFilter } = await searchParams;
  const { supabase, institutionId } = await requireAdminAccess(institutionParam);

  let progQuery = supabase
    .from("programs")
    .select("id, name, code, degree_type, duration_years, is_active, departments(name)")
    .eq("institution_id", institutionId)
    .order("name");

  if (q)                     progQuery = progQuery.or(`name.ilike.%${q}%,code.ilike.%${q}%`);
  if (status === "active")   progQuery = progQuery.eq("is_active", true);
  if (status === "inactive") progQuery = progQuery.eq("is_active", false);
  if (degree)                progQuery = progQuery.eq("degree_type", degree);
  if (deptFilter)            progQuery = progQuery.eq("department_id", deptFilter);

  const [{ data: programs }, { data: departments }] = await Promise.all([
    progQuery,
    supabase.from("departments").select("id, name").eq("institution_id", institutionId).eq("is_active", true).order("name"),
  ]);

  const deptOptions = (departments ?? []).map((d) => ({ value: d.id, label: d.name }));
  const FIELDS = [
    { key: "name",           label: "Name",        required: true },
    { key: "code",           label: "Code",        required: true },
    { key: "degree_type",    label: "Degree Type", type: "select" as const, required: true, options: DEGREE_TYPES },
    { key: "department_id",  label: "Department",  type: "select" as const, required: true, options: deptOptions },
    { key: "duration_years", label: "Duration (years)", placeholder: "4" },
    { key: "is_active",      label: "Active",      type: "checkbox" as const },
  ];
  const instParam = institutionParam ? `?institution=${institutionId}` : "";

  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        title="Programs"
        description="Degree programs offered within departments."
        action={
          <CrudDialog mode="create" table="programs" title="Program" fields={FIELDS}
            defaults={{ institution_id: institutionId, is_active: true }} />
        }
      />

      {/* ── Filters ─────────────────────────────────────────── */}
      <FilterBar
        filters={[
          { type: "search", placeholder: "Search name or code…" },
          { type: "select", key: "status",     label: "Status",     all: "All statuses",    options: STATUS_OPTIONS },
          { type: "select", key: "degree",     label: "Degree",     all: "All degrees",     options: DEGREE_TYPES  },
          { type: "select", key: "department", label: "Department", all: "All departments", options: deptOptions   },
        ]}
      />

      <DataTable<Program>
        rows={(programs ?? []) as unknown as Program[]}
        emptyText={q || status || degree || deptFilter ? "No programs match your filters." : "No programs yet. Create departments first."}
        columns={[
          {
            key: "name", label: "Name",
            render: (r) => (
              <Link href={`/admin/programs/${r.id}${instParam}`} className="font-medium hover:text-primary transition-colors">
                {r.name}
              </Link>
            ),
          },
          { key: "code",        label: "Code",       className: "w-28 font-mono text-xs" },
          { key: "degree_type", label: "Degree" },
          { key: "department",  label: "Department", render: (r) => (r.departments as { name: string } | null)?.name ?? "—" },
          { key: "duration_years", label: "Years",   render: (r) => r.duration_years ? `${r.duration_years}yr` : "—", className: "w-16 text-center" },
          { key: "is_active",   label: "Status",     render: (r) => <StatusBadge value={r.is_active} /> },
          {
            key: "actions", label: "", className: "w-20 text-right",
            render: (r) => (
              <div className="flex items-center justify-end gap-1">
                <Link href={`/admin/programs/${r.id}${instParam}`}>
                  <Button variant="ghost" size="sm" className="h-7 text-xs">View</Button>
                </Link>
                <CrudDialog
                  mode="edit" table="programs" title="Program" fields={FIELDS}
                  defaults={{ institution_id: institutionId }} rowId={r.id}
                  initial={{ name: r.name, code: r.code, degree_type: r.degree_type, duration_years: r.duration_years, is_active: r.is_active }}
                />
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
