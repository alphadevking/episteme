// app/admin/users/[id]/page.tsx
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { DetailShell } from "@/components/admin/detail-shell";
import { StatusBadge } from "@/components/admin/status-badge";
import { UserActions } from "@/components/admin/user-actions";

type Params = { params: Promise<{ id: string }> };

export default async function UserDetailPage({ params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClientReadOnly();

  const [{ data: user }, { data: claims }, { data: onboarding }] =
    await Promise.all([
      supabase
        .from("users")
        .select("id, email, first_name, last_name, phone, status, primary_role, roles, created_at, last_login_at, email_verified_at")
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("verification_claims")
        .select("id, claim_type, status, created_at")
        .eq("user_id", id)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("onboarding_sessions")
        .select("id, journey_type, status, current_step, total_steps, started_at, completed_at")
        .eq("user_id", id)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  if (!user) notFound();

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ") || "—";

  return (
    <DetailShell
      backHref="/admin/users"
      backLabel="All users"
      title={fullName}
      subtitle={user.email}
      action={<UserActions userId={user.id} currentStatus={user.status} currentRole={user.primary_role} />}
    >
      {/* Profile details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold">Profile</h2>
          <dl className="divide-y text-sm">
            {[
              { label: "Email", value: user.email },
              { label: "Phone", value: user.phone ?? "—" },
              { label: "Status", value: <StatusBadge value={user.status} /> },
              { label: "Role", value: <span className="capitalize">{user.primary_role}</span> },
              { label: "All roles", value: (user.roles as string[]).join(", ") },
              { label: "Joined", value: new Date(user.created_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) },
              { label: "Last login", value: user.last_login_at ? new Date(user.last_login_at).toLocaleDateString() : "Never" },
              { label: "Email verified", value: user.email_verified_at ? new Date(user.email_verified_at).toLocaleDateString() : "Not verified" },
            ].map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between py-2.5">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="space-y-4">
          {/* Onboarding */}
          <div className="rounded-lg border bg-card p-5 space-y-3">
            <h2 className="text-sm font-semibold">Onboarding</h2>
            {onboarding ? (
              <dl className="divide-y text-sm">
                {[
                  { label: "Journey", value: <span className="capitalize">{onboarding.journey_type}</span> },
                  { label: "Status", value: <StatusBadge value={onboarding.status} /> },
                  { label: "Progress", value: `Step ${onboarding.current_step} of ${onboarding.total_steps}` },
                  { label: "Started", value: new Date(onboarding.started_at).toLocaleDateString() },
                  { label: "Completed", value: onboarding.completed_at ? new Date(onboarding.completed_at).toLocaleDateString() : "—" },
                ].map(({ label, value }) => (
                  <div key={label} className="flex items-center justify-between py-2">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">No onboarding session found.</p>
            )}
          </div>

          {/* Recent claims */}
          <div className="rounded-lg border bg-card p-5 space-y-3">
            <h2 className="text-sm font-semibold">Recent Claims</h2>
            {claims && claims.length > 0 ? (
              <div className="divide-y text-sm">
                {(claims as { id: string; claim_type: string; status: string; created_at: string }[]).map((c) => (
                  <div key={c.id} className="flex items-center justify-between py-2">
                    <span className="capitalize text-muted-foreground">{c.claim_type.replace(/_/g, " ")}</span>
                    <StatusBadge value={c.status} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No claims submitted.</p>
            )}
          </div>
        </div>
      </div>
    </DetailShell>
  );
}