// components/admin/user-search-form.tsx
// Place at: components/admin/user-search-form.tsx
"use client";

import { useRouter, usePathname } from "next/navigation";
import { useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SearchIcon, XIcon } from "lucide-react";

type Props = {
  roles:          string[];
  statuses:       string[];
  currentQ?:      string;
  currentRole?:   string;
  currentStatus?: string;
};

export function UserSearchForm({
  roles,
  statuses,
  currentQ,
  currentRole,
  currentStatus,
}: Props) {
  const router   = useRouter();
  const pathname = usePathname();

  const update = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(window.location.search);
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname],
  );

  const clear = () => router.push(pathname);

  const hasFilters = currentQ || currentRole || currentStatus;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Text search */}
      <div className="relative flex-1 min-w-48">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input
          className="pl-8 h-9 text-sm"
          placeholder="Search name or email…"
          defaultValue={currentQ}
          onKeyDown={(e) => {
            if (e.key === "Enter")
              update("q", (e.target as HTMLInputElement).value);
          }}
          onBlur={(e) => update("q", e.target.value)}
        />
      </div>

      {/* Role filter */}
      <select
        value={currentRole ?? ""}
        onChange={(e) => update("role", e.target.value)}
        className="h-9 rounded border border-input bg-background px-3 text-sm text-foreground"
      >
        <option value="">All roles</option>
        {roles.map((r) => (
          <option key={r} value={r} className="capitalize">
            {r}
          </option>
        ))}
      </select>

      {/* Status filter */}
      <select
        value={currentStatus ?? ""}
        onChange={(e) => update("status", e.target.value)}
        className="h-9 rounded border border-input bg-background px-3 text-sm text-foreground"
      >
        <option value="">All statuses</option>
        {statuses.map((s) => (
          <option key={s} value={s}>
            {s.replace(/_/g, " ")}
          </option>
        ))}
      </select>

      {/* Clear */}
      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          className="h-9 gap-1.5 text-xs"
          onClick={clear}
        >
          <XIcon className="size-3.5" />
          Clear
        </Button>
      )}
    </div>
  );
}