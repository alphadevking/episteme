// components/admin/data-table.tsx
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { InboxIcon } from "lucide-react";

type Column<T> = {
  key:        string;
  label:      string;
  render?:    (row: T) => ReactNode;
  className?: string;
};

type Props<T extends { id: string }> = {
  columns:    Column<T>[];
  rows:       T[];
  emptyText?: string;
  emptyIcon?: ReactNode;
};

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  emptyText = "No records found.",
  emptyIcon,
}: Props<T>) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm">
        <thead>
          <tr className="border-b bg-muted/40">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
                  col.className,
                )}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>
                <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
                  {emptyIcon ?? <InboxIcon className="size-7 text-muted-foreground/30" />}
                  <p className="text-sm text-muted-foreground">{emptyText}</p>
                </div>
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id} className="hover:bg-muted/20 transition-colors">
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn("px-4 py-3", col.className)}
                  >
                    {col.render
                      ? col.render(row)
                      : String((row as Record<string, unknown>)[col.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      </div>

      {rows.length > 0 && (
        <div className="border-t bg-muted/20 px-4 py-2">
          <p className="text-xs text-muted-foreground">
            {rows.length} {rows.length === 1 ? "record" : "records"}
          </p>
        </div>
      )}
    </div>
  );
}
