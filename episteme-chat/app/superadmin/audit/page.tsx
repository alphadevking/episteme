// app/superadmin/audit/page.tsx
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { PageHeader } from "@/components/admin/page-header";
import { AuditLogClient, type AuditRow } from "@/components/admin/audit-log-client";

export default async function AuditPage() {
  const supabase = await createSupabaseServerClientReadOnly();

  const { data: logs } = await supabase
    .from("audit_logs")
    .select("id, action, resource_type, resource_id, actor_ip, created_at, actor:actor_user_id(email)")
    .order("created_at", { ascending: false })
    .limit(1000);

  return (
    <div>
      <PageHeader
        title="Audit Logs"
        description="Read-only record of all platform actions. Last 1,000 entries."
      />
      <AuditLogClient rows={(logs ?? []) as unknown as AuditRow[]} />
    </div>
  );
}
