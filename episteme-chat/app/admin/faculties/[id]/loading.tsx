// app/admin/faculties/[id]/loading.tsx

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

function DeptRowSkeleton({ opacity = 1 }: { opacity?: number }) {
  return (
    <div
      className="flex items-center gap-4 border-b last:border-0 px-4 py-3.5"
      style={{ opacity }}
    >
      {/* Code monogram */}
      <Shimmer className="size-7 shrink-0 rounded-md" />
      {/* Name */}
      <Shimmer className="h-3.5 flex-1 max-w-[200px]" />
      {/* Code pill */}
      <Shimmer className="h-5 w-12 rounded-md" />
      {/* HOD */}
      <Shimmer className="h-3.5 w-28" />
      {/* Status */}
      <Shimmer className="h-5 w-14 rounded-full" />
      {/* Chevron */}
      <Shimmer className="size-7 ml-auto rounded-md" />
    </div>
  );
}

export default function FacultyDetailLoading() {
  return (
    <div className="space-y-8 pb-10">

      {/* ── DetailShell header skeleton ───────────────────── */}
      <div className="space-y-1">
        {/* Back link */}
        <Shimmer className="h-3 w-24 mb-4" />
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            {/* Title */}
            <Shimmer className="h-8 w-56" />
            {/* Subtitle (code · dean) */}
            <Shimmer className="h-3.5 w-72" />
          </div>
          {/* Edit button */}
          <Shimmer className="h-9 w-24 rounded-md shrink-0" />
        </div>
      </div>

      {/* ── Info cards ────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {/* Departments card */}
        <div className="rounded-lg border bg-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <Shimmer className="h-2.5 w-20" />
            <Shimmer className="size-7 rounded-md" />
          </div>
          <Shimmer className="h-8 w-10" />
          <Shimmer className="h-2.5 w-14" />
        </div>

        {/* Status card */}
        <div className="rounded-lg border bg-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <Shimmer className="h-2.5 w-14" />
            <Shimmer className="size-7 rounded-md" />
          </div>
          <Shimmer className="h-5 w-16 rounded-full mt-1" />
        </div>

        {/* Dean card */}
        <div className="col-span-2 md:col-span-1 rounded-lg border bg-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <Shimmer className="h-2.5 w-10" />
            <Shimmer className="size-7 rounded-md" />
          </div>
          <Shimmer className="h-3.5 w-44" />
        </div>
      </div>

      {/* ── Departments table ─────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Shimmer className="h-2.5 w-24" />
          <Shimmer className="h-5 w-6 rounded-full" />
        </div>

        <div className="rounded-lg border bg-card overflow-hidden">
          {/* Table header */}
          <div className="flex items-center gap-4 border-b bg-muted/30 px-4 py-2.5">
            <Shimmer className="h-2.5 flex-1 max-w-[120px]" />
            <Shimmer className="h-2.5 w-12" />
            <Shimmer className="h-2.5 w-20" />
            <Shimmer className="h-2.5 w-14" />
            <Shimmer className="h-2.5 w-4 ml-auto" />
          </div>

          {Array.from({ length: 5 }).map((_, i) => (
            <DeptRowSkeleton key={i} opacity={1 - i * 0.12} />
          ))}
        </div>
      </div>

    </div>
  );
}