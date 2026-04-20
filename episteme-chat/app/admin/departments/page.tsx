// app/admin/departments/page.tsx
import { PageHeader } from "@/components/admin/page-header";
import { DataTable } from "@/components/admin/data-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { CrudDialog } from "@/components/admin/crud-dialog";
import { FilterBar } from "@/components/admin/filter-bar";
import { requireAdminAccess } from "@/lib/admin-guard";
import Link from "next/link";
import { Button } from "@/components/ui/button";

type Props = { searchParams: Promise<{ institution?: string; q?: string; status?: string; faculty?: string }> };

type Department = {
    id: string; name: string; code: string; is_active: boolean; faculty_id: string | null;
    faculties: { name: string } | null;
};

const STATUS_OPTIONS = [
  { value: "active",   label: "Active"   },
  { value: "inactive", label: "Inactive" },
];

export default async function DepartmentsPage({ searchParams }: Props) {
    const { institution: institutionParam, q, status, faculty: facultyFilter } = await searchParams;
    const { supabase, institutionId } = await requireAdminAccess(institutionParam);

    let deptQuery = supabase
        .from("departments")
        .select("id, name, code, is_active, faculty_id, faculties(name)")
        .eq("institution_id", institutionId)
        .order("name");

    if (q)                     deptQuery = deptQuery.or(`name.ilike.%${q}%,code.ilike.%${q}%`);
    if (status === "active")   deptQuery = deptQuery.eq("is_active", true);
    if (status === "inactive") deptQuery = deptQuery.eq("is_active", false);
    if (facultyFilter)         deptQuery = deptQuery.eq("faculty_id", facultyFilter);

    const [{ data: departments }, { data: faculties }] = await Promise.all([
        deptQuery,
        supabase.rpc("fn_readonly_list_active_faculties", { p_institution_id: institutionId }),
    ]);

    const facultyOptions = (faculties ?? []).map((f: { id: string; name: string }) => ({ value: f.id, label: f.name }));
    const FIELDS = [
        { key: "name", label: "Name", required: true },
        { key: "code", label: "Code", required: true },
        { key: "faculty_id", label: "Faculty", type: "select" as const, required: true, options: facultyOptions },
        { key: "is_active", label: "Active", type: "checkbox" as const },
    ];
    const instParam = institutionParam ? `?institution=${institutionId}` : "";

    return (
        <div className="space-y-6 pb-10">
            <PageHeader
                title="Departments"
                description="Departments grouped under faculties."
                action={
                    <CrudDialog mode="create" table="departments" title="Department" fields={FIELDS}
                        defaults={{ institution_id: institutionId, is_active: true }} />
                }
            />

            {/* ── Filters ─────────────────────────────────────── */}
            <FilterBar
                filters={[
                    { type: "search", placeholder: "Search name or code…" },
                    { type: "select", key: "status",  label: "Status",  all: "All statuses",  options: STATUS_OPTIONS },
                    { type: "select", key: "faculty", label: "Faculty", all: "All faculties", options: facultyOptions },
                ]}
            />

            <DataTable<Department>
                rows={(departments ?? []) as unknown as Department[]}
                emptyText={q || status || facultyFilter ? "No departments match your filters." : "No departments yet. Create faculties first."}
                columns={[
                    {
                        key: "name", label: "Name",
                        render: (r) => (
                            <Link href={`/admin/departments/${r.id}${instParam}`} className="font-medium hover:text-primary transition-colors">
                                {r.name}
                            </Link>
                        ),
                    },
                    { key: "code", label: "Code", className: "w-24 font-mono text-xs" },
                    { key: "faculty", label: "Faculty", render: (r) => (r.faculties as { name: string } | null)?.name ?? "—" },
                    { key: "is_active", label: "Status", render: (r) => <StatusBadge value={r.is_active} /> },
                    {
                        key: "actions", label: "", className: "w-24 text-right",
                        render: (r) => (
                            <div className="flex items-center justify-end gap-1">
                                <Link href={`/admin/departments/${r.id}${instParam}`}>
                                    <Button variant="ghost" size="sm" className="h-7 text-xs">View</Button>
                                </Link>
                                <CrudDialog
                                    mode="edit" table="departments" title="Department" fields={FIELDS}
                                    defaults={{ institution_id: institutionId }} rowId={r.id}
                                    initial={{ name: r.name, code: r.code, faculty_id: r.faculty_id ?? "", is_active: r.is_active }}
                                />
                            </div>
                        ),
                    },
                ]}
            />
        </div>
    );
}
