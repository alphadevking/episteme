// app/admin/onboarding/page.tsx
import { PageHeader } from "@/components/admin/page-header";
import { DataTable } from "@/components/admin/data-table";
import { requireAdminAccess } from "@/lib/admin-guard";
import Link from "next/link";
import { Button } from "@/components/ui/button";

type Props = { searchParams: Promise<{ institution?: string }> };
type OnboardingRow = {
    id: string; journey_type: string; current_step: number; total_steps: number;
    status: string; started_at: string; abandoned_at: string | null;
    user: { id: string; email: string; first_name: string | null; last_name: string | null } | null;
};

const formatDaysAgo = (d: string) => {
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return `${days} days ago`;
};

export default async function OnboardingMonitorPage({ searchParams }: Props) {
    const { institution: institutionParam } = await searchParams;
    const { supabase, isSuperadmin, institutionId } = await requireAdminAccess(institutionParam);

    const { data: sessions } = await supabase
        .from("onboarding_sessions")
        .select("id, journey_type, current_step, total_steps, status, started_at, abandoned_at, user:user_id(id, email, first_name, last_name)")
        .neq("status", "completed")
        .order("started_at", { ascending: false });

    const inProgress = (sessions ?? []).filter((s) => s.status === "in_progress");
    const abandoned = (sessions ?? []).filter((s) => s.status === "abandoned");
    const instParam = institutionParam ? `?institution=${institutionId}` : "";

    const userCol = (r: OnboardingRow) => {
        const u = Array.isArray(r.user) ? r.user[0] : r.user;
        return (
            <div>
                <p className="text-sm font-medium">{[u?.first_name, u?.last_name].filter(Boolean).join(" ") || "—"}</p>
                <p className="text-xs text-muted-foreground">{u?.email}</p>
            </div>
        );
    };

    const actionCol = (r: OnboardingRow) => {
        const u = Array.isArray(r.user) ? r.user[0] : r.user;
        return u?.id ? (
            <Link href={`/admin/users/${u.id}${instParam}`}>
                <Button variant="ghost" size="sm" className="h-7 text-xs">View user</Button>
            </Link>
        ) : null;
    };

    return (
        <div>
            <PageHeader title="Onboarding Monitor" description="Users who started but haven't completed onboarding." />
            <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="rounded-lg border bg-card p-4">
                    <p className="text-xs text-muted-foreground mb-1">In progress</p>
                    <p className="text-2xl font-semibold">{inProgress.length}</p>
                </div>
                <div className="rounded-lg border bg-card p-4">
                    <p className="text-xs text-muted-foreground mb-1">Abandoned</p>
                    <p className="text-2xl font-semibold">{abandoned.length}</p>
                </div>
            </div>

            <div className="space-y-3 mb-8">
                <h2 className="text-sm font-semibold">In Progress</h2>
                <DataTable<OnboardingRow>
                    rows={inProgress as unknown as OnboardingRow[]}
                    emptyText="No users currently in onboarding."
                    columns={[
                        { key: "user", label: "User", render: userCol },
                        { key: "journey_type", label: "Journey", className: "capitalize" },
                        {
                            key: "progress", label: "Progress",
                            render: (r) => (
                                <div className="flex items-center gap-2">
                                    <div className="h-1.5 w-24 rounded-full bg-muted overflow-hidden">
                                        <div className="h-full rounded-full bg-primary" style={{ width: `${(r.current_step / r.total_steps) * 100}%` }} />
                                    </div>
                                    <span className="text-xs text-muted-foreground">{r.current_step}/{r.total_steps}</span>
                                </div>
                            ),
                        },
                        { key: "started_at", label: "Started", render: (r) => <span className="text-xs text-muted-foreground">{formatDaysAgo(r.started_at)}</span> },
                        { key: "actions", label: "", className: "w-24 text-right", render: actionCol },
                    ]}
                />
            </div>

            {abandoned.length > 0 && (
                <div className="space-y-3">
                    <h2 className="text-sm font-semibold">Abandoned</h2>
                    <DataTable<OnboardingRow>
                        rows={abandoned as unknown as OnboardingRow[]}
                        emptyText="No abandoned sessions."
                        columns={[
                            { key: "user", label: "User", render: userCol },
                            { key: "journey_type", label: "Journey", className: "capitalize" },
                            { key: "progress", label: "Got to step", render: (r) => <span>{r.current_step} of {r.total_steps}</span> },
                            { key: "abandoned_at", label: "Abandoned", render: (r) => <span className="text-xs text-muted-foreground">{r.abandoned_at ? formatDaysAgo(r.abandoned_at) : "—"}</span> },
                            { key: "actions", label: "", className: "w-24 text-right", render: actionCol },
                        ]}
                    />
                </div>
            )}
        </div>
    );
}