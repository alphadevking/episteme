// app/superadmin/users/page.tsx
// Platform-wide user search across all institutions.
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { PageHeader } from "@/components/admin/page-header";
import { DataTable } from "@/components/admin/data-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { UserSearchForm } from "@/components/admin/user-search-form";

type SearchParams = { params: Promise<Record<string, never>>; searchParams: Promise<{ q?: string; role?: string; status?: string }> };

type UserRow = {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    primary_role: string;
    status: string;
    created_at: string;
    institutions: { name: string } | null;
};

export default async function SuperadminUsersPage({ searchParams }: SearchParams) {
    const { q, role, status } = await searchParams;
    const supabase = await createSupabaseServerClientReadOnly();

    let query = supabase
        .from("users")
        .select("id, email, first_name, last_name, primary_role, status, created_at, institutions(name)")
        .is("deleted_at", null)
        // Never expose superadmin accounts in the platform user list
        .eq("is_superadmin", false)
        .order("created_at", { ascending: false })
        .limit(100);

    if (q?.trim()) {
        query = query.or(`email.ilike.%${q.trim()}%,first_name.ilike.%${q.trim()}%,last_name.ilike.%${q.trim()}%`);
    }
    if (role) query = query.eq("primary_role", role);
    if (status) query = query.eq("status", status);

    const { data: users, count } = await query;

    const ROLES = ["prospective", "student", "parent", "guardian", "staff", "hod", "admin"];
    const STATUSES = ["pending_verification", "active", "suspended", "deactivated", "archived"];

    return (
        <div>
            <PageHeader
                title="Platform Users"
                description={`All users across all institutions. ${count ?? 0} total.`}
            />

            <UserSearchForm roles={ROLES} statuses={STATUSES} currentQ={q} currentRole={role} currentStatus={status} />

            <div className="mt-6">
                <DataTable<UserRow>
                    rows={(users ?? []) as unknown as UserRow[]}
                    emptyText="No users match your search."
                    columns={[
                        {
                            key: "name",
                            label: "Name / Email",
                            render: (r) => (
                                <div>
                                    <p className="font-medium text-sm">
                                        {[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}
                                    </p>
                                    <p className="text-xs text-muted-foreground">{r.email}</p>
                                </div>
                            ),
                        },
                        {
                            key: "institution",
                            label: "Institution",
                            render: (r) => (r.institutions as { name: string } | null)?.name ?? <span className="text-muted-foreground text-xs">None</span>,
                        },
                        {
                            key: "primary_role",
                            label: "Role",
                            className: "capitalize",
                        },
                        {
                            key: "status",
                            label: "Status",
                            render: (r) => <StatusBadge value={r.status} />,
                        },
                        {
                            key: "created_at",
                            label: "Joined",
                            render: (r) => (
                                <span className="text-xs text-muted-foreground">
                                    {new Date(r.created_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                                </span>
                            ),
                        },
                    ]}
                />
            </div>
        </div>
    );
}