// app/hod/page.tsx
// HOD overview — department stats and open claim counts.
import { getHodAssertion, getServerSupabase } from "@/lib/supabase/server-auth";
import { redirect } from "next/navigation";
import { StatusBadge } from "@/components/admin/status-badge";
import {
  FileCheckIcon,
  UsersIcon,
  BookOpenIcon,
  ClockIcon,
  AlertCircleIcon,
} from "lucide-react";
import Link from "next/link";

export default async function HodOverviewPage() {
  const supabase = await getServerSupabase();

  // Same atomic assertion the layout ran; request-cached, so this reuses it.
  const { row: ctx, error } = await getHodAssertion();
  if (error || !ctx) redirect("/sign-in");

  const [
    { data: programs },
    { count: studentsCount },
    { count: pendingCount },
    { count: inReviewCount },
    { count: urgentCount },
  ] = await Promise.all([
    supabase
      .from("programs")
      .select("id, name, degree_type, is_active")
      .eq("department_id", ctx.department_id)
      .order("name"),

    supabase
      .from("user_student_links")
      .select("id", { count: "exact", head: true })
      .eq("department_id", ctx.department_id)
      .eq("verification_status", "verified"),

    supabase
      .from("verification_claims")
      .select("*", { count: "exact", head: true })
      .eq("department_id", ctx.department_id)
      .eq("status", "pending"),

    supabase
      .from("verification_claims")
      .select("*", { count: "exact", head: true })
      .eq("assigned_to", ctx.user_id)
      .eq("status", "in_review"),

    supabase
      .from("verification_claims")
      .select("*", { count: "exact", head: true })
      .eq("assigned_to", ctx.user_id)
      .eq("is_urgent", true)
      .in("status", ["pending", "in_review"]),
  ]);

  const stats = [
    {
      label: "Programs",
      value: programs?.length ?? 0,
      icon: BookOpenIcon,
      color: "bg-accent-secondary-bg text-accent-secondary",
    },
    {
      label: "Verified Students",
      value: studentsCount ?? 0,
      icon: UsersIcon,
      color: "bg-info-bg text-info",
    },
    {
      label: "Pending Claims",
      value: pendingCount ?? 0,
      icon: ClockIcon,
      color: "bg-warning-bg text-warning",
      href: "/hod/claims?status=pending",
    },
    {
      label: "In Review",
      value: inReviewCount ?? 0,
      icon: FileCheckIcon,
      color: "bg-success-bg text-success",
      href: "/hod/claims?status=in_review",
    },
    {
      label: "Urgent",
      value: urgentCount ?? 0,
      icon: AlertCircleIcon,
      color: "bg-destructive/10 text-destructive",
      href: "/hod/claims?urgent=true",
    },
  ];

  return (
    <div className="space-y-8 pb-10">

      {/* Header */}
      <div>
        <h1 className="font-serif text-2xl font-semibold">{ctx.department_name}</h1>
        <p className="text-sm text-muted-foreground mt-1">Department overview</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map(({ label, value, icon: Icon, color, href }) => {
          const card = (
            <div className="rounded-lg border bg-card p-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {label}
                </p>
                <div className={`flex size-7 items-center justify-center rounded-md ${color}`}>
                  <Icon className="size-3.5" />
                </div>
              </div>
              <p className="text-2xl font-semibold tracking-tight">{value}</p>
            </div>
          );
          return href ? (
            <Link key={label} href={href} className="block hover:opacity-80 transition-opacity">
              {card}
            </Link>
          ) : (
            <div key={label}>{card}</div>
          );
        })}
      </div>

      {/* Programs */}
      <div className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          Programs
        </h2>
        <div className="rounded-lg border bg-card divide-y">
          {(programs ?? []).length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              No programs in this department yet.
            </p>
          ) : (
            (programs ?? []).map((p) => (
              <div key={p.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground capitalize mt-0.5">
                    {p.degree_type}
                  </p>
                </div>
                <StatusBadge value={p.is_active} />
              </div>
            ))
          )}
        </div>
      </div>

    </div>
  );
}
