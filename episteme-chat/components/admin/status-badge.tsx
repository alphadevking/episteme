// components/admin/status-badge.tsx
import { cn } from "@/lib/utils";

const VARIANTS: Record<string, string> = {
  active:               "bg-success-bg text-success dark:bg-success-bg dark:text-success",
  pending_verification: "bg-warning-bg text-warning dark:bg-warning-bg dark:text-warning",
  suspended:            "bg-error-bg text-error dark:bg-error-bg dark:text-error",
  deactivated:          "bg-muted text-muted-foreground dark:bg-muted dark:text-muted-foreground",
  archived:             "bg-muted text-muted-foreground dark:bg-muted dark:text-muted-foreground",
  pending:              "bg-warning-bg text-warning dark:bg-warning-bg dark:text-warning",
  in_review:            "bg-info-bg text-info dark:bg-info-bg dark:text-info",
  approved:             "bg-success-bg text-success dark:bg-success-bg dark:text-success",
  rejected:             "bg-error-bg text-error dark:bg-error-bg dark:text-error",
  cancelled:            "bg-muted text-muted-foreground",
  true:                 "bg-success-bg text-success",
  false:                "bg-muted text-muted-foreground",
};

export function StatusBadge({ value }: { value: string | boolean }) {
  const key = String(value);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize",
        VARIANTS[key] ?? "bg-muted text-muted-foreground",
      )}
    >
      {key.replace(/_/g, " ")}
    </span>
  );
}