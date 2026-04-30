"use client";

// components/admin/audit-log-client.tsx
// Client-side filterable, paginated audit log table.
// Uses the app's semantic token system throughout — no raw color utilities.

import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { SearchIcon, XIcon, ChevronLeftIcon, ChevronRightIcon, InboxIcon } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuditRow = {
  id:            string;
  action:        string;
  resource_type: string;
  resource_id:   string | null;
  actor_ip:      string | null;
  created_at:    string;
  actor:         { email: string } | null;
};

// ── Action badge ──────────────────────────────────────────────────────────────
// Maps action verbs to the app's semantic status tokens (same system as StatusBadge).

function actionClass(action: string): string {
  const verb = action.split(".").pop()?.toLowerCase() ?? action.toLowerCase();
  if (/create|insert|approve|reingest/.test(verb))  return "bg-success-bg text-success";
  if (/delete|remove|reject|cancel/.test(verb))      return "bg-error-bg text-error";
  if (/update|patch|edit|assign|verify|elevate/.test(verb)) return "bg-info-bg text-info";
  if (/ingest|upload|invite|send|reset/.test(verb))  return "bg-warning-bg text-warning";
  return "bg-muted text-muted-foreground";
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

const RANGE_OPTIONS = [
  { value: "",    label: "All time" },
  { value: "1",   label: "Today" },
  { value: "7",   label: "Last 7 days" },
  { value: "30",  label: "Last 30 days" },
  { value: "90",  label: "Last 90 days" },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function AuditLogClient({ rows }: { rows: AuditRow[] }) {
  const [search, setSearch] = useState("");
  const [range, setRange]   = useState("");
  const [page, setPage]     = useState(0);

  const filtered = useMemo(() => {
    const q    = search.toLowerCase().trim();
    const days = range ? parseInt(range, 10) : null;
    const from = days
      ? new Date(Date.now() - days * 86_400_000)
      : null;

    return rows.filter((r) => {
      if (q) {
        const hay = [r.action, r.resource_type, r.resource_id ?? "", r.actor?.email ?? "", r.actor_ip ?? ""]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (from && new Date(r.created_at) < from) return false;
      return true;
    });
  }, [rows, search, range]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRows   = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const hasFilters = search || range;

  function resetPage() { setPage(0); }
  function clearAll()  { setSearch(""); setRange(""); resetPage(); }

  return (
    <div className="space-y-4">

      {/* ── Filters — match FilterBar visual language ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => { setSearch(e.target.value); resetPage(); }}
            placeholder="Search action, resource, actor…"
            className={cn(
              "w-full rounded-md border bg-background pl-8 pr-3 py-1.5 text-sm",
              "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
              "placeholder:text-muted-foreground/60",
            )}
          />
        </div>

        <select
          value={range}
          onChange={(e) => { setRange(e.target.value); resetPage(); }}
          className={cn(
            "rounded-md border bg-background px-2.5 py-1.5 text-sm",
            "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
            range ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {RANGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {hasFilters && (
          <button
            onClick={clearAll}
            className="flex items-center gap-1 rounded-md border border-transparent px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground"
          >
            <XIcon className="size-3" />
            Clear
          </button>
        )}
      </div>

      {/* ── Table — match DataTable card shell ── */}
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                {["When", "Action", "Resource", "Resource ID", "Actor"].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody className="divide-y divide-border/60">
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
                      <InboxIcon className="size-7 text-muted-foreground/30" />
                      <p className="text-sm text-muted-foreground">
                        {rows.length === 0
                          ? "No audit log entries yet."
                          : "No entries match your filters."}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                pageRows.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-muted/20">
                    <td className="w-36 px-4 py-3 text-xs text-muted-foreground">
                      {new Date(row.created_at).toLocaleString("en-US", {
                        month: "short", day: "numeric",
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[11px] font-medium",
                          actionClass(row.action),
                        )}
                      >
                        {row.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground capitalize">
                      {row.resource_type?.replace(/_/g, " ") || "—"}
                    </td>
                    <td className="max-w-[160px] truncate px-4 py-3 font-mono text-[11px] text-muted-foreground/70">
                      {row.resource_id ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {row.actor?.email ?? row.actor_ip ?? (
                        <span className="italic text-muted-foreground/60">system</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center justify-between border-t bg-muted/20 px-4 py-2">
          <p className="text-xs text-muted-foreground">
            {filtered.length === rows.length
              ? `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`
              : `${filtered.length} of ${rows.length} entries`}
          </p>

          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <ChevronLeftIcon className="size-3.5" />
              </button>
              <span className="min-w-[4rem] text-center text-xs text-muted-foreground">
                {page + 1} / {totalPages}
              </span>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <ChevronRightIcon className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
