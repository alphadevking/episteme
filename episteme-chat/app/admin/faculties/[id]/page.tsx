// app/admin/faculties/[id]/page.tsx
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { DetailShell } from "@/components/admin/detail-shell";
import { CrudDialog } from "@/components/admin/crud-dialog";
import { DataTable } from "@/components/admin/data-table";
import { StatusBadge } from "@/components/admin/status-badge";
import Link from "next/link";
import {
  BuildingIcon,
  MailIcon,
  ChevronRightIcon,
  UserIcon,
  LayersIcon,
} from "lucide-react";

type Params = { params: Promise<{ id: string }> };

type HodUser = { email: string; first_name: string | null; last_name: string | null };
type DeptRow = {
  id:        string;
  name:      string;
  code:      string;
  is_active: boolean;
  hod:       HodUser[] | null;
};

function hodName(hod: HodUser[] | null): string {
  const h = hod?.[0];
  if (!h) return "—";
  return [h.first_name, h.last_name].filter(Boolean).join(" ") || h.email;
}

export default async function FacultyDetailPage({ params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClientReadOnly();

  const { data: me } = await supabase.from("users").select("institution_id").maybeSingle();

  const [{ data: faculty }, { data: departments }] = await Promise.all([
    supabase.from("faculties").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("departments")
      .select("id, name, code, is_active, hod:hod_user_id(email, first_name, last_name)")
      .eq("faculty_id", id)
      .order("name"),
  ]);

  if (!faculty) notFound();

  const FIELDS = [
    { key: "name",       label: "Name",       required: true },
    { key: "code",       label: "Code",       required: true },
    { key: "dean_email", label: "Dean Email", type: "email" as const },
    { key: "is_active",  label: "Active",     type: "checkbox" as const },
  ];

  const depts = (departments ?? []) as unknown as DeptRow[];
  const activeCount = depts.filter((d) => d.is_active).length;

  return (
    <DetailShell
      backHref="/admin/faculties"
      backLabel="All faculties"
      title={faculty.name}
      subtitle={`Code: ${faculty.code}${faculty.dean_email ? ` · Dean: ${faculty.dean_email}` : ""}`}
      action={
        <CrudDialog
          mode="edit"
          table="faculties"
          title="Faculty"
          fields={FIELDS}
          defaults={{ institution_id: me?.institution_id }}
          rowId={faculty.id}
          initial={{
            name:       faculty.name,
            code:       faculty.code,
            dean_email: faculty.dean_email ?? "",
            is_active:  faculty.is_active,
          }}
        />
      }
    >
      <div className="space-y-8 pb-10">

        {/* ── Info cards ──────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">

          {/* Departments count */}
          <div className="rounded-lg border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Departments
              </p>
              <div className="flex size-7 items-center justify-center rounded-md bg-accent-secondary-bg text-accent-secondary">
                <LayersIcon className="size-3.5" />
              </div>
            </div>
            <p className="text-2xl font-semibold tracking-tight text-foreground">
              {depts.length}
            </p>
            {depts.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {activeCount} active
              </p>
            )}
          </div>

          {/* Status */}
          <div className="rounded-lg border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Status
              </p>
              <div className="flex size-7 items-center justify-center rounded-md bg-success-bg text-success">
                <BuildingIcon className="size-3.5" />
              </div>
            </div>
            <div className="pt-1">
              <StatusBadge value={faculty.is_active} />
            </div>
          </div>

          {/* Dean */}
          <div className="col-span-2 md:col-span-1 rounded-lg border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Dean
              </p>
              <div className="flex size-7 items-center justify-center rounded-md bg-info-bg text-info">
                <UserIcon className="size-3.5" />
              </div>
            </div>
            {faculty.dean_email ? (
              <a
                href={`mailto:${faculty.dean_email}`}
                className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary transition-colors truncate"
              >
                <MailIcon className="size-3.5 shrink-0 text-muted-foreground" />
                {faculty.dean_email}
              </a>
            ) : (
              <p className="text-sm text-muted-foreground">—</p>
            )}
          </div>
        </div>

        {/* ── Departments table ────────────────────────────────── */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Departments
            </h2>
            {depts.length > 0 && (
              <span className="inline-flex items-center rounded-full border bg-card px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                {depts.length}
              </span>
            )}
          </div>

          <div className="rounded-lg border bg-card overflow-hidden">
            <DataTable<DeptRow>
              rows={depts}
              emptyText="No departments in this faculty yet."
              emptyIcon={<LayersIcon className="size-8 text-muted-foreground/40" />}
              columns={[
                {
                  key:   "name",
                  label: "Department",
                  render: (r) => (
                    <div className="flex items-center gap-3">
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
                        <span className="text-[10px] font-bold text-muted-foreground tracking-wide">
                          {r.code.slice(0, 3).toUpperCase()}
                        </span>
                      </div>
                      <Link
                        href={`/admin/departments/${r.id}`}
                        className="text-sm font-medium text-foreground hover:text-primary transition-colors"
                      >
                        {r.name}
                      </Link>
                    </div>
                  ),
                },
                {
                  key:   "code",
                  label: "Code",
                  className: "w-24",
                  render: (r) => (
                    <span className="inline-flex items-center rounded-md border bg-muted/50 px-2 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
                      {r.code}
                    </span>
                  ),
                },
                {
                  key:   "hod",
                  label: "HOD",
                  className: "text-sm text-muted-foreground",
                  render: (r) => (
                    <span className="text-sm text-muted-foreground">{hodName(r.hod)}</span>
                  ),
                },
                {
                  key:   "is_active",
                  label: "Status",
                  className: "w-28",
                  render: (r) => <StatusBadge value={r.is_active} />,
                },
                {
                  key:   "actions",
                  label: "",
                  className: "w-10 text-right",
                  render: (r) => (
                    <Link href={`/admin/departments/${r.id}`}>
                      <span className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                        <ChevronRightIcon className="size-4" />
                      </span>
                    </Link>
                  ),
                },
              ]}
            />
          </div>
        </div>

      </div>
    </DetailShell>
  );
}