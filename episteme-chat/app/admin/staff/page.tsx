// app/admin/staff/page.tsx
// Staff provisioning dashboard: HOD gaps, pending invites, active staff, expired invites.
//
// Schema reality (confirmed against live DB):
//   - users has NO department_id column.
//   - HOD→department link lives on departments.hod_user_id (FK → users.id).
//   - General staff have no department association — fn_redeem_invite_token only
//     updates departments.hod_user_id for the 'hod' role.
//   - To show an HOD's department: reverse-join — build a Map<user_id, deptName>
//     from the departments rows already fetched for HOD gaps.
import { PageHeader }         from "@/components/admin/page-header";
import { StatusBadge }        from "@/components/admin/status-badge";
import { requireAdminAccess } from "@/lib/admin-guard";
import { CancelInviteButton } from "@/components/admin/cancel-invite-button";
import Link                   from "next/link";
import { Button }             from "@/components/ui/button";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ClockIcon,
  UserCogIcon,
  UserPlusIcon,
  XCircleIcon,
} from "lucide-react";

type Props = { searchParams: Promise<{ institution?: string }> };

type DeptRow = {
  id:          string;
  name:        string;
  hod_user_id: string | null;
};

type InviteRow = {
  id:            string;
  email:         string;
  role:          string;
  department_id: string | null;
  expires_at:    string;
  created_at:    string;
  departments:   { name: string } | null;
};

type StaffRow = {
  id:           string;
  email:        string;
  first_name:   string | null;
  last_name:    string | null;
  primary_role: string;
  status:       string;
};

export default async function StaffPage({ searchParams }: Props) {
  const { institution: institutionParam } = await searchParams;
  const { supabase, institutionId }       = await requireAdminAccess(institutionParam);

  const now = new Date().toISOString();

  const [
    { data: depts },
    { data: pendingInvites },
    { data: expiredInvites },
    { data: staffUsers },
  ] = await Promise.all([
    // All departments — split into with/without HOD below
    supabase
      .from("departments")
      .select("id, name, hod_user_id")
      .eq("institution_id", institutionId)
      .order("name"),

    // Pending (unredeemed, not expired) invites — departments(name) works via FK
    supabase
      .from("invite_tokens")
      .select("id, email, role, department_id, expires_at, created_at, departments(name)")
      .eq("institution_id", institutionId)
      .is("redeemed_at", null)
      .gt("expires_at", now)
      .order("created_at", { ascending: false }),

    // Expired (unredeemed, past expiry) invites — last 20, informational only
    supabase
      .from("invite_tokens")
      .select("id, email, role, department_id, expires_at, created_at, departments(name)")
      .eq("institution_id", institutionId)
      .is("redeemed_at", null)
      .lte("expires_at", now)
      .order("expires_at", { ascending: false })
      .limit(20),

    // Provisioned staff + HOD users — no department_id on users; use hodDeptMap below
    supabase
      .from("users")
      .select("id, email, first_name, last_name, primary_role, status")
      .eq("institution_id", institutionId)
      .in("primary_role", ["staff", "hod"])
      .is("deleted_at", null)
      .order("primary_role")
      .order("last_name"),
  ]);

  // Build HOD → department name reverse-map from departments data
  const hodDeptMap = new Map<string, string>(
    (depts ?? [])
      .filter((d): d is DeptRow & { hod_user_id: string } => d.hod_user_id !== null)
      .map((d) => [d.hod_user_id, d.name]),
  );

  const hodGaps   = (depts ?? []).filter((d) => !d.hod_user_id);
  const instParam = institutionParam ? `?institution=${institutionId}` : "";

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

  return (
    <div className="space-y-8 pb-10">
      <PageHeader
        title="Staff Provisioning"
        description="Manage HOD assignments, invite staff, and review all provisioned personnel."
      />

      {/* ── HOD Gaps ──────────────────────────────────────────────────────── */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
            <AlertCircleIcon className="size-3.5 text-warning" />
            HOD Gaps
            {hodGaps.length > 0 && (
              <span className="ml-1 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
                {hodGaps.length}
              </span>
            )}
          </h2>
        </div>

        {hodGaps.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success-bg/40 px-4 py-3 text-sm text-success">
            <CheckCircle2Icon className="size-4 shrink-0" />
            All departments have an assigned HOD.
          </div>
        ) : (
          <div className="divide-y rounded-lg border bg-card overflow-hidden">
            {hodGaps.map((dept) => (
              <div key={dept.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{dept.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">No HOD assigned</p>
                </div>
                <Link href={`/admin/departments/${dept.id}${instParam}`}>
                  <Button size="sm" variant="outline" className="gap-1.5 shrink-0">
                    <UserPlusIcon className="size-3.5" />
                    Assign / Invite HOD
                  </Button>
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Pending Invites ───────────────────────────────────────────────── */}
      <section>
        <div className="mb-3 flex items-center gap-1.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
            <ClockIcon className="size-3.5 text-info" />
            Pending Invites
            {(pendingInvites ?? []).length > 0 && (
              <span className="ml-1 rounded-full bg-info/15 px-2 py-0.5 text-[11px] font-semibold text-info">
                {(pendingInvites ?? []).length}
              </span>
            )}
          </h2>
        </div>

        {!(pendingInvites ?? []).length ? (
          <p className="text-sm text-muted-foreground">No pending invites.</p>
        ) : (
          <div className="divide-y rounded-lg border bg-card overflow-hidden">
            {(pendingInvites as InviteRow[]).map((inv) => (
              <div key={inv.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{inv.email}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    <span className="capitalize font-medium">{inv.role}</span>
                    {inv.departments?.name && <> · {inv.departments.name}</>}
                    {" · "}Expires {fmtDate(inv.expires_at)}
                  </p>
                </div>
                <CancelInviteButton inviteId={inv.id} />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Provisioned Staff ─────────────────────────────────────────────── */}
      <section>
        <div className="mb-3 flex items-center gap-1.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
            <UserCogIcon className="size-3.5 text-primary" />
            Provisioned Staff
            {(staffUsers ?? []).length > 0 && (
              <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                {(staffUsers ?? []).length}
              </span>
            )}
          </h2>
        </div>

        {!(staffUsers ?? []).length ? (
          <p className="text-sm text-muted-foreground">No staff provisioned yet.</p>
        ) : (
          <div className="divide-y rounded-lg border bg-card overflow-hidden">
            {(staffUsers as StaffRow[]).map((u) => {
              // HODs: look up department via reverse-map. Staff: no dept stored.
              const deptName = u.primary_role === "hod" ? hodDeptMap.get(u.id) : undefined;
              return (
                <div key={u.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">
                      {[u.first_name, u.last_name].filter(Boolean).join(" ") || u.email}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {u.email}
                      {deptName && <> · {deptName}</>}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {u.primary_role === "hod" ? "HOD" : "Staff"}
                    </span>
                    <StatusBadge value={u.status} />
                    <Link href={`/admin/users/${u.id}${instParam}`}>
                      <Button variant="ghost" size="sm" className="h-7 text-xs">View</Button>
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Expired Invites (informational) ───────────────────────────────── */}
      {(expiredInvites ?? []).length > 0 && (
        <section>
          <div className="mb-3 flex items-center gap-1.5">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
              <XCircleIcon className="size-3.5 text-muted-foreground" />
              Expired Invites
              <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                {(expiredInvites ?? []).length}
              </span>
            </h2>
          </div>
          <div className="divide-y rounded-lg border bg-card overflow-hidden opacity-60">
            {(expiredInvites as InviteRow[]).map((inv) => (
              <div key={inv.id} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground truncate">{inv.email}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    <span className="capitalize">{inv.role}</span>
                    {inv.departments?.name && <> · {inv.departments.name}</>}
                    {" · "}Expired {fmtDate(inv.expires_at)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
