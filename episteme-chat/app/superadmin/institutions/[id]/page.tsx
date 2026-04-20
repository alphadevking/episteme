// app/superadmin/institutions/[id]/page.tsx
// Fix: use separate count query instead of relying on count from select.
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { DetailShell } from "@/components/admin/detail-shell";
import { InstitutionDialog } from "@/components/admin/institution-dialog";
import { DataTable } from "@/components/admin/data-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { ProvisionAdminForm } from "@/components/admin/provision-admin-form";

type Params = { params: Promise<{ id: string }> };

export default async function InstitutionDetailPage({ params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClientReadOnly();

  const [
    { data: inst },
    { data: faculties },
    { data: admins },
    { count: userCount },
  ] = await Promise.all([
    supabase.from("institutions").select("*").eq("id", id).maybeSingle(),
    supabase.from("faculties").select("id, name, code, is_active").eq("institution_id", id).order("name"),
    supabase.from("users").select("id, email, first_name, last_name, status").eq("institution_id", id).contains("roles", ["admin"]).eq("is_superadmin", false).is("deleted_at", null),
    // Separate count query — avoids the missing .count property issue
    supabase.from("users").select("id", { count: "exact", head: true }).eq("institution_id", id).eq("is_superadmin", false).is("deleted_at", null),
  ]);

  if (!inst) notFound();

  return (
    <DetailShell
      backHref="/superadmin/institutions"
      backLabel="All institutions"
      title={inst.name}
      subtitle={`${inst.code}${inst.domain ? ` · ${inst.domain}` : ""}`}
      action={<InstitutionDialog mode="edit" institution={inst} />}
    >
      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total users",  value: userCount ?? 0 },
          { label: "Faculties",    value: faculties?.length ?? 0 },
          { label: "Admins",       value: admins?.length ?? 0 },
          { label: "Status",       value: inst.is_active ? "Active" : "Inactive" },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border bg-card p-4">
            <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
            <p className="text-xl font-semibold">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Admins */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Institution Admins</h2>
          <ProvisionAdminForm />
        </div>
        <DataTable
          rows={(admins ?? []) as { id: string; email: string; first_name: string | null; last_name: string | null; status: string }[]}
          emptyText="No admins yet."
          columns={[
            { key: "name",   label: "Name",   render: (r) => [r.first_name, r.last_name].filter(Boolean).join(" ") || "—" },
            { key: "email",  label: "Email" },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
          ]}
        />
      </div>

      {/* Faculties */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Faculties</h2>
        <DataTable
          rows={(faculties ?? []) as { id: string; name: string; code: string; is_active: boolean }[]}
          emptyText="No faculties yet."
          columns={[
            { key: "name",      label: "Name" },
            { key: "code",      label: "Code",   className: "font-mono text-xs w-24" },
            { key: "is_active", label: "Status", render: (r) => <StatusBadge value={r.is_active} /> },
          ]}
        />
      </div>
    </DetailShell>
  );
}