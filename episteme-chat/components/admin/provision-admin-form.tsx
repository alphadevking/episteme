// components/admin/provision-admin-form.tsx
"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/types/database";
import { ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ProvisionAdminForm() {
  const supabase = createSupabaseBrowserClient();
  const router   = useRouter();

  const [open,   setOpen]   = useState(false);
  const [email,  setEmail]  = useState("");
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);
  const [success,setSuccess]= useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);

    // fn_provision_superadmin is for superadmins — for admin provisioning
    // we UPDATE the user's roles directly. The user must exist and have
    // an institution_id set (completed onboarding).
    const { data: target, error: findErr } = await supabase
      .from("users")
      .select("id, institution_id, roles")
      .eq("email", email.trim())
      .maybeSingle();

    if (findErr || !target) {
      setError("No user found with that email.");
      setSaving(false);
      return;
    }

    if (!target.institution_id) {
      setError("User has not completed onboarding (no institution set).");
      setSaving(false);
      return;
    }

    const updatedRoles = Array.from(
      new Set([...(target.roles ?? []), "admin"]),
    );

    const { error: updateErr } = await supabase
      .from("users")
      .update({ primary_role: "admin", roles: updatedRoles as Database["public"]["Enums"]["user_role"][] })
      .eq("id", target.id);

    setSaving(false);

    if (updateErr) {
      setError(updateErr.message);
      return;
    }

    setSuccess(true);
    setTimeout(() => {
      setOpen(false);
      setSuccess(false);
      setEmail("");
      router.refresh();
    }, 1500);
  };

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="sm" className="gap-1.5">
        <ShieldCheckIcon className="size-4" />
        Provision Admin
      </Button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-xl">
        <h2 className="mb-1 text-base font-semibold">Provision Admin</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          The user must have completed onboarding and have an institution assigned.
        </p>

        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {success && (
          <div className="mb-4 rounded-md border border-success/40 bg-success-bg px-3 py-2 text-sm text-success">
            Admin provisioned successfully.
          </div>
        )}

        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="admin-email">User email *</Label>
            <Input
              id="admin-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@institution.edu"
              required
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => { setOpen(false); setError(null); }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || success}>
              {saving ? "Provisioning…" : "Provision"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}