// app/admin/users/page.tsx
import { PageHeader } from "@/components/admin/page-header";
import { DataTable } from "@/components/admin/data-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { FilterBar } from "@/components/admin/filter-bar";
import { requireAdminAccess } from "@/lib/admin-guard";
import Link from "next/link";
import { Button } from "@/components/ui/button";

type Props = { searchParams: Promise<{ institution?: string; q?: string; status?: string; role?: string }> };
type UserRow = { id: string; email: string; first_name: string | null; last_name: string | null; primary_role: string; status: string; created_at: string };

const STATUS_OPTIONS = [
  { value: "active",   label: "Active"   },
  { value: "inactive", label: "Inactive" },
  { value: "pending",  label: "Pending"  },
];

const ROLE_OPTIONS = [
  { value: "admin",       label: "Admin"       },
  { value: "hod",         label: "HOD"         },
  { value: "staff",       label: "Staff"       },
  { value: "student",     label: "Student"     },
  { value: "parent",      label: "Parent"      },
  { value: "prospective", label: "Prospective" },
];

export default async function UsersPage({ searchParams }: Props) {
    const { institution: institutionParam, q, status, role } = await searchParams;
    const { supabase, institutionId } = await requireAdminAccess(institutionParam);

    let query = supabase
        .from("users")
        .select("id, email, first_name, last_name, primary_role, status, created_at")
        .eq("institution_id", institutionId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

    if (q)      query = query.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`);
    if (status) query = query.eq("status", status);
    if (role)   query = query.eq("primary_role", role);

    const { data: users } = await query;

    const instParam = institutionParam ? `?institution=${institutionId}` : "";

    return (
        <div className="space-y-6 pb-10">
            <PageHeader title="Users" description="All users in this institution." />

            {/* ── Filters ─────────────────────────────────────── */}
            <FilterBar
                filters={[
                    { type: "search", placeholder: "Search name or email…" },
                    { type: "select", key: "status", label: "Status", all: "All statuses", options: STATUS_OPTIONS },
                    { type: "select", key: "role",   label: "Role",   all: "All roles",    options: ROLE_OPTIONS  },
                ]}
            />

            <DataTable<UserRow>
                rows={(users ?? []) as UserRow[]}
                emptyText={q || status || role ? "No users match your filters." : "No users yet."}
                columns={[
                    {
                        key: "name", label: "Name",
                        render: (r) => (
                            <Link href={`/admin/users/${r.id}${instParam}`} className="font-medium hover:text-primary transition-colors">
                                {[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}
                            </Link>
                        ),
                    },
                    { key: "email", label: "Email" },
                    { key: "primary_role", label: "Role", className: "capitalize" },
                    { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} /> },
                    {
                        key: "created_at", label: "Joined",
                        render: (r) => new Date(r.created_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }),
                        className: "text-muted-foreground text-xs",
                    },
                    {
                        key: "actions", label: "", className: "w-20 text-right",
                        render: (r) => (
                            <Link href={`/admin/users/${r.id}${instParam}`}>
                                <Button variant="ghost" size="sm" className="h-7 text-xs">View</Button>
                            </Link>
                        ),
                    },
                ]}
            />
        </div>
    );
}
