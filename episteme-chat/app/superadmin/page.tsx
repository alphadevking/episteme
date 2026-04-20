// app/superadmin/page.tsx
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { PageHeader } from "@/components/admin/page-header";
import { BuildingIcon, UsersIcon, ShieldCheckIcon, FileTextIcon } from "lucide-react";

export default async function SuperadminDashboard() {
  const supabase = await createSupabaseServerClientReadOnly();

  const [
    { count: institutionCount },
    { count: userCount },
    { count: adminCount },
    { count: claimCount },
  ] = await Promise.all([
    supabase.from("institutions").select("id", { count: "exact", head: true }),
    supabase.from("users").select("id", { count: "exact", head: true }).is("deleted_at", null).eq("is_superadmin", false),
    supabase.from("users").select("id", { count: "exact", head: true }).contains("roles", ["admin"]).eq("is_superadmin", false),
    supabase.from("verification_claims").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  const stats = [
    { label: "Institutions",    value: institutionCount ?? 0, icon: BuildingIcon,     href: "/superadmin/institutions" },
    { label: "Total Users",     value: userCount      ?? 0, icon: UsersIcon,          href: null },
    { label: "Admins",          value: adminCount     ?? 0, icon: ShieldCheckIcon,    href: "/superadmin/admins" },
    { label: "Pending Claims",  value: claimCount     ?? 0, icon: FileTextIcon,       href: null },
  ];

  return (
    <div>
      <PageHeader
        title="Platform Overview"
        description="Superadmin dashboard — all institutions."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-lg border bg-card p-4 space-y-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{s.label}</span>
              <s.icon className="size-4 text-muted-foreground" />
            </div>
            <p className="text-2xl font-semibold">{s.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}