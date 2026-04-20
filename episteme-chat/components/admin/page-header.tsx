// components/admin/page-header.tsx
import type { ReactNode } from "react";

type Props = {
  title:        string;
  description?: string;
  action?:      ReactNode;
};

export function PageHeader({ title, description, action }: Props) {
  return (
    <div className="mb-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">{title}</h1>
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="mt-4 h-px bg-border" />
    </div>
  );
}
