// components/admin/detail-shell.tsx
// Reusable wrapper for all [id] detail pages.
// Provides back link, title, optional action slot, and content area.
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

type Props = {
  backHref:    string;
  backLabel:   string;
  title:       string;
  subtitle?:   string;
  action?:     ReactNode;
  children:    ReactNode;
};

export function DetailShell({
  backHref,
  backLabel,
  title,
  subtitle,
  action,
  children,
}: Props) {
  return (
    <div className="space-y-6">
      {/* Back navigation */}
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronLeftIcon className="size-3.5" />
        {backLabel}
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && (
            <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>

      {/* Content */}
      {children}
    </div>
  );
}