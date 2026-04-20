// app/admin/programs/[id]/page.tsx
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { DetailShell } from "@/components/admin/detail-shell";
import { CrudDialog } from "@/components/admin/crud-dialog";
import { StatusBadge } from "@/components/admin/status-badge";

type Params = { params: Promise<{ id: string }> };

export default async function ProgramDetailPage({ params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClientReadOnly();

  const { data: me } = await supabase.from("users").select("institution_id").maybeSingle();

  const [{ data: program }, { data: departments }] = await Promise.all([
    supabase
      .from("programs")
      .select("*, department:department_id(name)")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("departments")
      .select("id, name")
      .eq("institution_id", me?.institution_id ?? "")
      .eq("is_active", true)
      .order("name"),
  ]);

  if (!program) notFound();

  const deptOptions = (departments ?? []).map((d) => ({ value: d.id, label: d.name }));

  const DEGREE_TYPES = ["Bachelor","Master","PhD","Diploma","Certificate"].map(
    (d) => ({ value: d, label: d }),
  );

  const FIELDS = [
    { key: "name",           label: "Name",        required: true },
    { key: "code",           label: "Code",        required: true },
    { key: "degree_type",    label: "Degree Type", type: "select" as const, required: true, options: DEGREE_TYPES },
    { key: "department_id",  label: "Department",  type: "select" as const, required: true, options: deptOptions },
    { key: "duration_years", label: "Duration (years)", placeholder: "4" },
    { key: "is_active",      label: "Active",      type: "checkbox" as const },
  ];

  const dept = program.department as { name: string } | null;

  return (
    <DetailShell
      backHref="/admin/programs"
      backLabel="All programs"
      title={program.name}
      subtitle={`${program.code} · ${program.degree_type} · ${dept?.name ?? "—"}`}
      action={
        <CrudDialog
          mode="edit"
          table="programs"
          title="Program"
          fields={FIELDS}
          defaults={{ institution_id: me?.institution_id }}
          rowId={program.id}
          initial={{
            name:           program.name,
            code:           program.code,
            degree_type:    program.degree_type,
            department_id:  program.department_id,
            duration_years: program.duration_years ?? "",
            is_active:      program.is_active,
          }}
        />
      }
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Degree",     value: program.degree_type },
          { label: "Department", value: dept?.name ?? "—" },
          { label: "Duration",   value: program.duration_years ? `${program.duration_years} years` : "—" },
          { label: "Status",     value: <StatusBadge value={program.is_active} /> },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border bg-card p-4">
            <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
            <div className="text-sm font-semibold">{s.value}</div>
          </div>
        ))}
      </div>
    </DetailShell>
  );
}