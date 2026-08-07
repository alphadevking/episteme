// app/admin/departments/[id]/page.tsx
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { DetailShell } from "@/components/admin/detail-shell";
import { CrudDialog } from "@/components/admin/crud-dialog";
import { DataTable } from "@/components/admin/data-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { HODPicker } from "@/components/admin/hod-picker";
import { InviteStaffForm } from "@/components/admin/invite-staff-form";

type Params = { params: Promise<{ id: string }> };

export default async function DepartmentDetailPage({ params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClientReadOnly();

  const { data: me } = await supabase.from("users").select("institution_id").maybeSingle();

  const [{ data: dept }, { data: programs }, { data: faculties }] = await Promise.all([
    supabase
      .from("departments")
      .select("*, faculty:faculty_id(name), hod:hod_user_id(id, email, first_name, last_name)")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("programs")
      .select("id, name, code, degree_type, duration_years, is_active")
      .eq("department_id", id)
      .order("name"),
    supabase
      .from("faculties")
      .select("id, name")
      .eq("institution_id", me?.institution_id ?? "")
      .eq("is_active", true)
      .order("name"),
  ]);

  if (!dept) notFound();

  const facultyOptions = (faculties ?? []).map((f) => ({ value: f.id, label: f.name }));

  const FIELDS = [
    { key: "name",       label: "Name",    required: true },
    { key: "code",       label: "Code",    required: true },
    { key: "faculty_id", label: "Faculty", type: "select" as const, required: true, options: facultyOptions },
    { key: "is_active",  label: "Active",  type: "checkbox" as const },
  ];

  const hod = dept.hod as { id: string; email: string; first_name: string | null; last_name: string | null } | null;

  return (
    <DetailShell
      backHref="/admin/departments"
      backLabel="All departments"
      title={dept.name}
      subtitle={`${dept.code} · ${(dept.faculty as { name: string } | null)?.name ?? "—"}`}
      action={
        <CrudDialog
          mode="edit"
          table="departments"
          title="Department"
          fields={FIELDS}
          defaults={{ institution_id: me?.institution_id ?? undefined }}
          rowId={dept.id}
          initial={{
            name:       dept.name,
            code:       dept.code,
            faculty_id: dept.faculty_id,
            is_active:  dept.is_active,
          }}
        />
      }
    >
      {/* Info cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {[
          { label: "Programs",  value: programs?.length ?? 0 },
          { label: "Status",    value: <StatusBadge value={dept.is_active} /> },
          { label: "Faculty",   value: (dept.faculty as { name: string } | null)?.name ?? "—" },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border bg-card p-4">
            <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
            <div className="text-sm font-semibold">{s.value}</div>
          </div>
        ))}
      </div>

      {/* HOD assignment + staff invite */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex-1">
          <HODPicker
            departmentId={dept.id}
            institutionId={me?.institution_id ?? ""}
            currentHod={hod}
          />
        </div>
        <div className="shrink-0 pt-1">
          <InviteStaffForm
            departmentId={dept.id}
            departmentName={dept.name}
          />
        </div>
      </div>

      {/* Programs */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Programs</h2>
        <DataTable
          rows={(programs ?? []) as { id: string; name: string; code: string; degree_type: string; duration_years: number | null; is_active: boolean }[]}
          emptyText="No programs in this department yet."
          columns={[
            { key: "name",           label: "Name" },
            { key: "code",           label: "Code",    className: "font-mono text-xs w-28" },
            { key: "degree_type",    label: "Degree" },
            { key: "duration_years", label: "Years",   render: (r) => r.duration_years ? `${r.duration_years}yr` : "—" },
            { key: "is_active",      label: "Status",  render: (r) => <StatusBadge value={r.is_active} /> },
          ]}
        />
      </div>
    </DetailShell>
  );
}