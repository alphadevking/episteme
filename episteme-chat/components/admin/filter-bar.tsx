// components/admin/filter-bar.tsx
// URL-driven filter bar: search (debounced), selects. Wraps useSearchParams in Suspense.
"use client";

import { Suspense, useEffect, useRef, useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type FilterConfig =
  | { type: "search"; key?: string; placeholder?: string }
  | { type: "select"; key: string; label: string; all?: string; options: { value: string; label: string }[] };

type Props = { filters: FilterConfig[] };

// ── Inner (needs useSearchParams) ─────────────────────────────────────────────
function FilterBarInner({ filters }: Props) {
  const router      = useRouter();
  const pathname    = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const searchFilter = filters.find((f) => f.type === "search") as { type: "search"; key?: string; placeholder?: string } | undefined;
  const searchKey    = searchFilter?.key ?? "q";

  const [localSearch, setLocalSearch] = useState(searchParams.get(searchKey) ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local search in sync if URL changes (e.g. clear all)
  useEffect(() => {
    setLocalSearch(searchParams.get(searchKey) ?? "");
  }, [searchParams, searchKey]);

  function pushParams(updates: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v);
      else    params.delete(k);
    }
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  function handleSearchChange(value: string) {
    setLocalSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => pushParams({ [searchKey]: value }), 350);
  }

  function clearAll() {
    const params = new URLSearchParams(searchParams.toString());
    for (const f of filters) {
      const key = f.type === "search" ? searchKey : f.key;
      params.delete(key);
    }
    setLocalSearch("");
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  const activeCount = filters.filter((f) => {
    const key = f.type === "search" ? searchKey : f.key;
    return !!searchParams.get(key);
  }).length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filters.map((f, i) => {
        if (f.type === "search") {
          return (
            <div key={i} className="relative flex-1 min-w-[180px] max-w-xs">
              <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
              <input
                type="search"
                value={localSearch}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder={f.placeholder ?? "Search…"}
                className={cn(
                  "w-full rounded-md border bg-background pl-8 pr-3 py-1.5 text-sm",
                  "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
                  "placeholder:text-muted-foreground/60",
                )}
              />
            </div>
          );
        }

        if (f.type === "select") {
          const current = searchParams.get(f.key) ?? "";
          return (
            <select
              key={i}
              value={current}
              onChange={(e) => pushParams({ [f.key]: e.target.value })}
              className={cn(
                "rounded-md border bg-background px-2.5 py-1.5 text-sm",
                "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
                current ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <option value="">{f.all ?? `All ${f.label}s`}</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          );
        }

        return null;
      })}

      {activeCount > 0 && (
        <button
          onClick={clearAll}
          className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors border border-transparent hover:border-border"
        >
          <XIcon className="size-3" />
          Clear{activeCount > 1 ? ` (${activeCount})` : ""}
        </button>
      )}
    </div>
  );
}

// ── Skeleton (shown while useSearchParams resolves) ───────────────────────────
function FilterBarSkeleton({ filters }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {filters.map((f, i) => (
        <div
          key={i}
          className={cn(
            "h-8 animate-pulse rounded-md bg-muted",
            f.type === "search" ? "w-48" : "w-32",
          )}
        />
      ))}
    </div>
  );
}

// ── Public export (Suspense boundary included) ────────────────────────────────
export function FilterBar(props: Props) {
  return (
    <Suspense fallback={<FilterBarSkeleton {...props} />}>
      <FilterBarInner {...props} />
    </Suspense>
  );
}
