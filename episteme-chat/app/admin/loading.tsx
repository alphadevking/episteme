// app/admin/loading.tsx
//
// Mirrors the exact section layout of the admin dashboard:
//   1. PageHeader skeleton
//   2. Stats grid (2-col mobile / 4-col desktop)
//   3. AI Quality card
//   4. Quick actions list
//
// Uses the Stitch shimmer animation via --animate-shimmer + bg-gradient trick.
// No external deps — pure Tailwind + CSS vars.

function Shimmer({ className = "" }: { className?: string }) {
  return (
    <div
      className={`
        relative overflow-hidden rounded-md bg-muted
        before:absolute before:inset-0
        before:bg-[linear-gradient(90deg,transparent_0%,hsl(var(--foreground)/0.06)_50%,transparent_100%)]
        before:bg-[length:200%_100%]
        before:animate-[shimmer-sweep_1.4s_linear_infinite]
        ${className}
      `}
    />
  );
}

function StatCardSkeleton() {
  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-2 flex-1">
          <Shimmer className="h-2.5 w-16" />
          <Shimmer className="h-7 w-12" />
        </div>
        <Shimmer className="size-8 shrink-0 rounded-md" />
      </div>
      <Shimmer className="h-px w-0" /> {/* matches the hover line spacer */}
    </div>
  );
}

function QuickLinkSkeleton() {
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <div className="flex items-center gap-3 flex-1">
        <Shimmer className="size-8 shrink-0 rounded-md" />
        <div className="space-y-1.5 flex-1">
          <Shimmer className="h-3.5 w-40" />
          <Shimmer className="h-2.5 w-56" />
        </div>
      </div>
      <Shimmer className="size-4 ml-3 shrink-0 rounded-sm" />
    </div>
  );
}

export default function AdminDashboardLoading() {
  return (
    <div className="space-y-8 pb-10">

      {/* ── PageHeader skeleton ───────────────────────────── */}
      <div className="space-y-2">
        <Shimmer className="h-7 w-48" />
        <Shimmer className="h-4 w-72" />
      </div>

      {/* ── Stats grid ───────────────────────────────────── */}
      <section>
        <Shimmer className="mb-3 h-2.5 w-20" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
      </section>

      {/* ── AI Quality card ──────────────────────────────── */}
      <section>
        <Shimmer className="mb-3 h-2.5 w-32" />
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            {/* left: icon + figure */}
            <div className="flex items-center gap-4">
              <Shimmer className="size-10 shrink-0 rounded-md" />
              <div className="space-y-2">
                <Shimmer className="h-2.5 w-36" />
                <Shimmer className="h-8 w-20" />
              </div>
            </div>
            {/* right: counts */}
            <div className="flex items-center gap-5">
              <div className="space-y-1.5 text-right">
                <Shimmer className="h-2.5 w-16 ml-auto" />
                <Shimmer className="h-4 w-10 ml-auto" />
              </div>
              <div className="h-8 w-px bg-border" />
              <div className="space-y-1.5 text-right">
                <Shimmer className="h-2.5 w-20 ml-auto" />
                <Shimmer className="h-4 w-8 ml-auto" />
              </div>
            </div>
          </div>
          {/* progress bar */}
          <Shimmer className="h-2 w-full rounded-full" />
        </div>
      </section>

      {/* ── Quick actions ─────────────────────────────────── */}
      <section>
        <Shimmer className="mb-3 h-2.5 w-24" />
        <div className="divide-y rounded-lg border bg-card overflow-hidden">
          {Array.from({ length: 3 }).map((_, i) => (
            <QuickLinkSkeleton key={i} />
          ))}
        </div>
      </section>
    </div>
  );
}