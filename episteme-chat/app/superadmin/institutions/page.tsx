// app/superadmin/institutions/page.tsx
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { PageHeader } from "@/components/admin/page-header";
import { DataTable } from "@/components/admin/data-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { InstitutionDialog } from "@/components/admin/institution-dialog";
import { ManageInstitutionButton } from "@/components/admin/institution-switcher";
import Link from "next/link";

type Institution = { id: string; name: string; code: string; domain: string | null; is_active: boolean; created_at: string };

export default async function InstitutionsPage() {
    const supabase = await createSupabaseServerClientReadOnly();
    const { data: institutions } = await supabase
        .from("institutions")
        .select("id, name, code, domain, is_active, created_at")
        .order("created_at", { ascending: false });

    return (
        <div>
            <PageHeader
                title="Institutions"
                description="Manage the universities and colleges on the platform."
                action={<InstitutionDialog mode="create" />}
            />
            <DataTable<Institution>
                rows={(institutions ?? []) as Institution[]}
                emptyText="No institutions yet. Create one to unblock onboarding."
                columns={[
                    {
                        key: "name", label: "Name",
                        render: (r) => (
                            <Link href={`/superadmin/institutions/${r.id}`} className="font-medium hover:text-primary transition-colors">
                                {r.name}
                            </Link>
                        ),
                    },
                    { key: "code", label: "Code", className: "w-24 font-mono text-xs" },
                    { key: "domain", label: "Domain", className: "text-muted-foreground" },
                    { key: "is_active", label: "Status", render: (r) => <StatusBadge value={r.is_active} /> },
                    {
                        key: "created_at", label: "Created",
                        render: (r) => new Date(r.created_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }),
                    },
                    {
                        key: "actions", label: "", className: "w-44 text-right",
                        render: (r) => (
                            <div className="flex items-center justify-end gap-1">
                                <ManageInstitutionButton institutionId={r.id} />
                                <InstitutionDialog mode="edit" institution={r} />
                            </div>
                        ),
                    },
                ]}
            />
        </div>
    );
}