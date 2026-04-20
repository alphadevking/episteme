// components/admin/institution-dialog.tsx
// Create or edit an institution. Used by superadmin only.
"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { PlusIcon, PencilIcon, LandmarkIcon } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Institution = {
  id:        string;
  name:      string;
  code:      string;
  domain:    string | null;
  is_active: boolean;
};

type Props =
  | { mode: "create" }
  | { mode: "edit"; institution: Institution };

export function InstitutionDialog(props: Props) {
  const supabase = createSupabaseBrowserClient();
  const router   = useRouter();

  const [open,   setOpen]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  const initial =
    props.mode === "edit"
      ? {
          name:      props.institution.name,
          code:      props.institution.code,
          domain:    props.institution.domain ?? "",
          is_active: props.institution.is_active,
        }
      : { name: "", code: "", domain: "", is_active: true };

  const [form, setForm] = useState(initial);

  const set = (k: keyof typeof initial, v: string | boolean) =>
    setForm((f) => ({ ...f, [k]: v }));

  function handleOpenChange(val: boolean) {
    if (!val) setError(null);
    setOpen(val);
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);

    const payload = {
      name:      form.name.trim(),
      code:      form.code.trim().toUpperCase(),
      domain:    form.domain.trim() || null,
      is_active: form.is_active,
    };

    const { error: err } =
      props.mode === "create"
        ? await supabase.from("institutions").insert(payload)
        : await supabase
            .from("institutions")
            .update(payload)
            .eq("id", props.institution.id);

    setSaving(false);

    if (err) {
      setError(err.message);
      return;
    }

    setOpen(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {props.mode === "create" ? (
          <Button size="sm" className="gap-1.5">
            <PlusIcon className="size-4" />
            New Institution
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="gap-1.5">
            <PencilIcon className="size-3.5" />
            Edit
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-md p-0 gap-0">
        {/* ── Header ── */}
        <DialogHeader className="flex-row items-center gap-3 border-b px-5 py-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <LandmarkIcon className="size-4 text-primary" />
          </div>
          <div className="min-w-0">
            <DialogTitle className="text-sm leading-tight">
              {props.mode === "create" ? "New Institution" : "Edit Institution"}
            </DialogTitle>
            <p className="mt-0.5 text-xs text-muted-foreground leading-tight">
              {props.mode === "create"
                ? "Add a new institution to the platform."
                : "Update institution details."}
            </p>
          </div>
        </DialogHeader>

        {/* ── Form ── */}
        <form onSubmit={submit} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

          {/* Institution name */}
          <div className="space-y-1.5">
            <Label htmlFor="inst-name" className="text-xs">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="inst-name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="University of Example"
              required
              className="h-8 text-xs"
            />
          </div>

          {/* Code + Domain side by side */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="inst-code" className="text-xs">
                Code <span className="text-destructive">*</span>
              </Label>
              <Input
                id="inst-code"
                value={form.code}
                onChange={(e) => set("code", e.target.value)}
                placeholder="UOE"
                required
                className="h-8 text-xs uppercase"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inst-domain" className="text-xs">
                Domain{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="inst-domain"
                value={form.domain}
                onChange={(e) => set("domain", e.target.value)}
                placeholder="uoe.edu"
                className="h-8 text-xs"
              />
            </div>
          </div>

          {/* Active toggle — pill chip style */}
          <div className="space-y-1.5">
            <Label className="text-xs">Status</Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => set("is_active", true)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  form.is_active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                }`}
              >
                Active
              </button>
              <button
                type="button"
                onClick={() => set("is_active", false)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  !form.is_active
                    ? "border-destructive bg-destructive/10 text-destructive"
                    : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                }`}
              >
                Inactive
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          {/* Footer actions */}
          <div className="flex justify-end gap-2 pt-1 pb-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? (
                <span className="flex items-center gap-1.5">
                  <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Saving…
                </span>
              ) : (
                props.mode === "create" ? "Create Institution" : "Save Changes"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}