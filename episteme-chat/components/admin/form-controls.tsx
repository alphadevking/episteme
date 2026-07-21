"use client";

import type { ChangeEvent } from "react";
import { ChevronDownIcon } from "lucide-react";

export const inputBase =
  "w-full h-9 rounded-lg border border-input bg-background px-3 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring transition-colors";

export const selectBase =
  "w-full h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring transition-colors appearance-none cursor-pointer";

export function LabelledSelect({
  value, onChange, options, placeholder, disabled,
}: {
  value: string;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select value={value} onChange={onChange} className={selectBase} disabled={disabled}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <div className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center">
        <ChevronDownIcon className="size-3.5 text-muted-foreground" />
      </div>
    </div>
  );
}

/** Multi-select pill toggle — same visual pattern used for Roles/Level Scope in the ingest form. */
export function PillToggleGroup({
  options, selected, onToggle, labels,
}: {
  options: readonly string[];
  selected: string[];
  onToggle: (value: string) => void;
  labels?: Record<string, string>;
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-0.5">
      {options.map((opt) => {
        const active = selected.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onToggle(opt)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground"
            }`}
          >
            {labels?.[opt] ?? opt}
          </button>
        );
      })}
    </div>
  );
}
