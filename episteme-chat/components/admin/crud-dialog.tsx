// components/admin/crud-dialog.tsx
// Generic create/edit dialog for simple flat tables (faculties, departments, programs).
// Validation: Zod schema auto-built from FieldDef + react-hook-form.
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { PlusIcon, PencilIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/types/database";

// ── DB typing ─────────────────────────────────────────────────────────────────
// Narrowed to the three tables this dialog actually manages.
// Keeping the union small lets TypeScript fully resolve the conditional types
// without needing any type assertions on the Supabase call sites.
type CrudTableName = "faculties" | "departments" | "programs";

type Tables = Database["public"]["Tables"];
type RowInsert<T extends CrudTableName> = Tables[T]["Insert"];
type RowUpdate<T extends CrudTableName>  = Tables[T]["Update"];

// ── Field definition ──────────────────────────────────────────────────────────
export type FieldDef = {
  key:          string;
  label:        string;
  type?:        "text" | "email" | "select" | "checkbox";
  options?:     { value: string; label: string }[];
  required?:    boolean;
  placeholder?: string;
};

// ── Zod schema builder ────────────────────────────────────────────────────────
function buildSchema(fields: FieldDef[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) {
    if (f.type === "checkbox") {
      shape[f.key] = z.boolean();
    } else if (f.type === "email") {
      const base = z.string().email("Invalid email address");
      shape[f.key] = f.required
        ? base.min(1, `${f.label} is required`)
        : z.union([base, z.literal("")]).optional();
    } else {
      const base = z.string();
      shape[f.key] = f.required
        ? base.min(1, `${f.label} is required`)
        : base.optional();
    }
  }
  return z.object(shape);
}

function emptyValues(fields: FieldDef[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((f) => [f.key, f.type === "checkbox" ? false : ""]),
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────
type Props<T extends CrudTableName> = {
  table:     T;
  title:     string;
  fields:    FieldDef[];
  defaults:  Partial<RowInsert<T>>;
  mode:      "create" | "edit";
  rowId?:    string;
  initial?:  Partial<RowUpdate<T>>;
};

// ── Component ─────────────────────────────────────────────────────────────────
export function CrudDialog<T extends CrudTableName>({
  table, title, fields, defaults, mode, rowId, initial,
}: Props<T>) {
  const supabase = createSupabaseBrowserClient();
  const router   = useRouter();
  const [open, setOpen] = useState(false);

  const schema = useMemo(() => buildSchema(fields), [fields]);
  type FormValues = z.infer<typeof schema>;

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: ((initial ?? emptyValues(fields)) as FormValues),
  });

  // Sync form to latest initial values whenever the dialog opens
  useEffect(() => {
    if (open) {
      const vals = (initial ?? emptyValues(fields)) as FormValues;
      // console.log("[CrudDialog] reset values:", vals, "| fields:", fields);
      reset(vals);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSubmit = async (values: FormValues) => {
    const payload: Record<string, unknown> = { ...defaults };
    for (const f of fields) {
      const val = values[f.key as keyof FormValues];
      // Coerce empty string → null for optional DB fields
      payload[f.key] = val === "" ? null : val;
    }

    // Narrow `table` to a literal so TypeScript can resolve Supabase's
    // conditional types without requiring `any`.
    const run = () => {
      switch (table) {
        case "faculties":
          return mode === "create"
            ? supabase.from("faculties").insert(payload as Tables["faculties"]["Insert"])
            : supabase.from("faculties").update(payload as Tables["faculties"]["Update"]).eq("id", rowId!);
        case "departments":
          return mode === "create"
            ? supabase.from("departments").insert(payload as Tables["departments"]["Insert"])
            : supabase.from("departments").update(payload as Tables["departments"]["Update"]).eq("id", rowId!);
        case "programs":
          return mode === "create"
            ? supabase.from("programs").insert(payload as Tables["programs"]["Insert"])
            : supabase.from("programs").update(payload as Tables["programs"]["Update"]).eq("id", rowId!);
      }
    };
    const { error: err } = await run();

    if (err) {
      setError("root", { message: err.message });
      return;
    }

    setOpen(false);
    router.refresh();
  };

  return (
    <>
      {/* Trigger */}
      {mode === "create" ? (
        <Button onClick={() => setOpen(true)} size="sm" className="gap-1.5">
          <PlusIcon className="size-4" />
          {title}
        </Button>
      ) : (
        <Button onClick={() => setOpen(true)} variant="ghost" size="sm">
          <PencilIcon className="size-3.5 mr-1" />
          Edit
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>
              {mode === "create" ? `New ${title}` : `Edit ${title}`}
            </DialogTitle>
          </DialogHeader>

          {errors.root?.message && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errors.root.message}
            </div>
          )}

          <form id="crud-form" className="space-y-4" onSubmit={handleSubmit(onSubmit)}>
            {fields.map((f) => {
              const fieldError = errors[f.key as keyof FormValues];
              const errMsg = fieldError && "message" in fieldError && typeof fieldError.message === "string"
                ? fieldError.message
                : undefined;

              return (
                <div key={f.key} className="space-y-1.5">
                  {f.type !== "checkbox" && (
                    <Label htmlFor={f.key}>
                      {f.label}
                      {f.required && <span className="text-destructive ml-0.5">*</span>}
                    </Label>
                  )}

                  {f.type === "select" ? (
                    <select
                      id={f.key}
                      {...register(f.key as keyof FormValues & string)}
                      aria-invalid={errMsg ? "true" : undefined}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 aria-[invalid=true]:border-destructive"
                    >
                      <option value="">Select…</option>
                      {f.options?.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : f.type === "checkbox" ? (
                    <label
                      htmlFor={f.key}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md border bg-muted/30 px-3 py-2.5 hover:bg-muted/50 transition-colors"
                    >
                      <input
                        id={f.key}
                        type="checkbox"
                        {...register(f.key as keyof FormValues & string)}
                        className="size-4 rounded border-input accent-primary"
                      />
                      <span className="text-sm font-normal text-foreground">
                        {f.label}
                      </span>
                    </label>
                  ) : (
                    <Input
                      id={f.key}
                      type={f.type ?? "text"}
                      placeholder={f.placeholder}
                      aria-invalid={errMsg ? "true" : undefined}
                      {...register(f.key as keyof FormValues & string)}
                    />
                  )}

                  {errMsg && (
                    <p className="text-xs text-destructive">{errMsg}</p>
                  )}
                </div>
              );
            })}
          </form>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isSubmitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" form="crud-form" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : mode === "create" ? "Create" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
