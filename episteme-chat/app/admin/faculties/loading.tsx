// app/admin/faculties/loading.tsx

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

function TableRowSkeleton() {
  return (
    <div className="flex items-center gap-4 px-4 py-3.5 border-b last:border-0">
      {/* Monogram avatar */}
      <Shimmer className="size-8 shrink-0 rounded-md" />

      {/* Name + email */}
      <div className="flex-1 space-y-1.5 min-w-0">
        <Shimmer className="h-3.5 w-48" />
        <Shimmer className="h-2.5 w-36" />
      </div>

      {/* Code pill */}
      <Shimmer className="h-5 w-12 rounded-md" />

      {/* Status badge */}
      <Shimmer className="h-5 w-14 rounded-full" />

      {/* Action buttons */}
      <div className="flex items-center gap-1 ml-auto">
        <Shimmer className="h-7 w-7 rounded-md" />
        <Shimmer className="h-7 w-7 rounded-md" />
      </div>
    </div>
  );
}

export default function FacultiesLoading() {
  return (
    <div className="space-y-6 pb-10">

      {/* ── PageHeader skeleton ───────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Shimmer className="h-7 w-28" />
          <Shimmer className="h-4 w-64" />
        </div>
        {/* CrudDialog trigger button */}
        <Shimmer className="h-9 w-32 rounded-md" />
      </div>

      {/* ── Summary pills ─────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <Shimmer className="h-6 w-24 rounded-full" />
        <Shimmer className="h-6 w-16 rounded-full" />
      </div>

      {/* ── Table ─────────────────────────────────────────── */}
      <div className="rounded-lg border bg-card overflow-hidden">
        {/* Table header */}
        <div className="flex items-center gap-4 border-b bg-muted/30 px-4 py-2.5">
          <Shimmer className="h-2.5 flex-1" />
          <Shimmer className="h-2.5 w-12" />
          <Shimmer className="h-2.5 w-14" />
          <Shimmer className="h-2.5 w-16 ml-auto" />
        </div>

        {/* Rows — staggered opacity to feel natural */}
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ opacity: 1 - i * 0.1 }}>
            <TableRowSkeleton />
          </div>
        ))}
      </div>
    </div>
  );
}