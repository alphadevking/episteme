// app/admin/page.tsx
import { PageHeader } from "@/components/admin/page-header";
import {
  UsersIcon,
  BookOpenIcon,
  BuildingIcon,
  FileTextIcon,
  GraduationCapIcon,
  ClipboardListIcon,
  ChevronRightIcon,
  ThumbsUpIcon,
  SparklesIcon,
  UserCogIcon,
} from "lucide-react";
import { requireAdminAccess } from "@/lib/admin-guard";
import Link from "next/link";

type Props = { searchParams: Promise<{ institution?: string }> };

export default async function AdminDashboard({ searchParams }: Props) {
  const { institution: institutionParam } = await searchParams;
  const { supabase, isSuperadmin, institutionId } = await requireAdminAccess(institutionParam);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: institution },
    { count: userCount },
    { count: facultyCount },
    { count: departmentCount },
    { count: programCount },
    { count: claimCount },
    { count: feedbackTotal },
    { count: feedbackHelpful },
    { count: hodGapCount },
  ] = await Promise.all([
    supabase.from("institutions").select("name").eq("id", institutionId).maybeSingle(),
    supabase.from("users").select("id", { count: "exact", head: true }).eq("institution_id", institutionId).is("deleted_at", null),
    supabase.from("faculties").select("id", { count: "exact", head: true }).eq("institution_id", institutionId),
    supabase.from("departments").select("id", { count: "exact", head: true }).eq("institution_id", institutionId),
    supabase.from("programs").select("id", { count: "exact", head: true }).eq("institution_id", institutionId),
    supabase.from("verification_claims").select("id", { count: "exact", head: true }).eq("institution_id", institutionId).eq("status", "pending"),
    supabase.from("chat_message_feedback").select("id", { count: "exact", head: true }).eq("institution_id", institutionId).gte("created_at", thirtyDaysAgo),
    supabase.from("chat_message_feedback").select("id", { count: "exact", head: true }).eq("institution_id", institutionId).eq("helpful", true).gte("created_at", thirtyDaysAgo),
    supabase.from("departments").select("id", { count: "exact", head: true }).eq("institution_id", institutionId).is("hod_user_id", null),
  ]);

  const total = feedbackTotal ?? 0;
  const helpful = feedbackHelpful ?? 0;
  const helpfulPct = total > 0 ? Math.round((helpful / total) * 100) : null;

  const instParam = institutionParam ? `?institution=${institutionId}` : "";

  const stats = [
    {
      label: "Users",
      value: userCount ?? 0,
      icon: UsersIcon,
      href: `/admin/users${instParam}`,
      color: "text-info",
      bg: "bg-info-bg",
      border: "border-info/20",
    },
    {
      label: "Faculties",
      value: facultyCount ?? 0,
      icon: BookOpenIcon,
      href: `/admin/faculties${instParam}`,
      color: "text-accent-secondary",
      bg: "bg-accent-secondary-bg",
      border: "border-accent-secondary/20",
    },
    {
      label: "Departments",
      value: departmentCount ?? 0,
      icon: BuildingIcon,
      href: `/admin/departments${instParam}`,
      color: "text-success",
      bg: "bg-success-bg",
      border: "border-success/20",
    },
    {
      label: "Programs",
      value: programCount ?? 0,
      icon: GraduationCapIcon,
      href: `/admin/programs${instParam}`,
      color: "text-warning",
      bg: "bg-warning-bg",
      border: "border-warning/20",
    },
  ];

  const quickLinks = [
    {
      label: "Review pending claims",
      description: "Verify and approve student identity requests",
      href: `/admin/claims${instParam}`,
      icon: FileTextIcon,
      badge: claimCount ?? 0,
      badgeVariant: "primary" as const,
    },
    {
      label: "Provision staff & HODs",
      description: "Invite staff, assign HODs, review pending invites",
      href: `/admin/staff${instParam}`,
      icon: UserCogIcon,
      badge: hodGapCount ?? 0,
      badgeVariant: "warning" as const,
    },
    {
      label: "Monitor onboarding",
      description: "Track new user setup and completion rates",
      href: `/admin/onboarding${instParam}`,
      icon: ClipboardListIcon,
      badge: null,
      badgeVariant: null,
    },
    {
      label: "Manage knowledge base",
      description: "Add and organise AI reference materials",
      href: `/admin/knowledge${instParam}`,
      icon: BookOpenIcon,
      badge: null,
      badgeVariant: null,
    },
  ];

  return (
    <div className="space-y-8 pb-10">
      <PageHeader
        title={institution?.name ?? "Institution"}
        description="Overview of your institution's data and activity."
      />

      {/* ── Stats grid ──────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          At a glance
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((s) => (
            <Link key={s.label} href={s.href} className="group block">
              <div
                className={`
                  relative overflow-hidden rounded-lg border bg-card p-4
                  transition-all duration-200
                  hover:shadow-md hover:-translate-y-0.5
                  ${s.border}
                `}
              >
                {/* subtle tinted corner wash */}
                <div
                  className={`pointer-events-none absolute -right-4 -top-4 size-16 rounded-full opacity-10 ${s.bg}`}
                />

                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-2">
                    <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                      {s.label}
                    </span>
                    <p className="text-2xl font-semibold tracking-tight text-foreground">
                      {s.value.toLocaleString()}
                    </p>
                  </div>
                  <div
                    className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${s.bg} ${s.color}`}
                  >
                    <s.icon className="size-4" />
                  </div>
                </div>

                {/* hover underline accent */}
                <div
                  className={`
                    mt-3 h-px w-0 rounded-full transition-all duration-300
                    group-hover:w-full ${s.bg}
                  `}
                />
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* ── AI Quality metric ────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          AI quality · last 30 days
        </h2>

        <div className="rounded-lg border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            {/* Icon + main figure */}
            <div className="flex items-center gap-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-success-bg text-success">
                <ThumbsUpIcon className="size-4" />
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Helpful response rate
                </p>
                <div className="flex items-baseline gap-2 mt-0.5">
                  <p className="text-3xl font-semibold tracking-tight text-foreground">
                    {helpfulPct !== null ? `${helpfulPct}%` : "—"}
                  </p>
                  {helpfulPct !== null && (
                    <span className="text-xs text-muted-foreground font-medium">
                      satisfaction
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Counts */}
            {total > 0 && (
              <div className="flex items-center gap-5 text-right">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Total ratings</p>
                  <p className="text-sm font-semibold text-foreground">{total.toLocaleString()}</p>
                </div>
                <div className="h-8 w-px bg-border" />
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Marked helpful</p>
                  <p className="text-sm font-semibold text-success">{helpful.toLocaleString()}</p>
                </div>
              </div>
            )}
          </div>

          {/* Progress bar */}
          {total > 0 && (
            <div className="mt-4 space-y-1.5">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-success transition-all duration-700"
                  style={{ width: `${helpfulPct}%` }}
                />
              </div>
            </div>
          )}

          {total === 0 && (
            <div className="mt-4 flex items-start gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2.5">
              <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                No feedback collected yet. Thumbs-up / thumbs-down buttons appear below each AI response.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ── Quick actions ─────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          Quick actions
        </h2>

        <div className="divide-y rounded-lg border bg-card overflow-hidden">
          {quickLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="group flex items-center justify-between px-4 py-3.5 transition-colors hover:bg-muted/40"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground transition-colors group-hover:text-foreground">
                  <link.icon className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{link.label}</span>
                    {link.badge !== null && link.badge > 0 && (
                      <span className={[
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                        link.badgeVariant === "warning"
                          ? "bg-warning/15 text-warning"
                          : "bg-primary/10 text-primary",
                      ].join(" ")}>
                        {link.badge}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {link.description}
                  </p>
                </div>
              </div>
              <ChevronRightIcon className="ml-3 size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}