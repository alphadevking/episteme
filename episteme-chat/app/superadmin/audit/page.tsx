// app/superadmin/audit/page.tsx
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { PageHeader } from "@/components/admin/page-header";
import { DataTable } from "@/components/admin/data-table";

type AuditRow = {
  id:            string;
  action:        string;
  resource_type: string;
  resource_id:   string | null;
  actor_ip:      string | null;
  created_at:    string;
  actor:         { email: string } | null;
};

export default async function AuditPage() {
  const supabase = await createSupabaseServerClientReadOnly();

  const { data: logs } = await supabase
    .from("audit_logs")
    .select("id, action, resource_type, resource_id, actor_ip, created_at, actor:actor_user_id(email)")
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div>
      <PageHeader
        title="Audit Logs"
        description="Read-only record of all platform actions. Last 200 entries."
      />

      <DataTable<AuditRow>
        rows={(logs ?? []) as unknown as AuditRow[]}
        emptyText="No audit log entries yet."
        columns={[
          {
            key:    "created_at",
            label:  "When",
            render: (row) =>
              new Date(row.created_at).toLocaleString("en-US", {
                month: "short", day: "numeric",
                hour: "2-digit", minute: "2-digit",
              }),
            className: "w-40 text-muted-foreground text-xs",
          },
          { key: "action",        label: "Action",   className: "font-mono text-xs" },
          { key: "resource_type", label: "Resource", className: "text-xs" },
          {
            key:    "actor",
            label:  "Actor",
            render: (row) => row.actor?.email ?? row.actor_ip ?? "system",
            className: "text-xs text-muted-foreground",
          },
        ]}
      />
    </div>
  );
}