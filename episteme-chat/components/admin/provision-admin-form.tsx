// components/admin/provision-admin-form.tsx
"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
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

    // Admin provisioning goes through the gated fn_admin_set_user_role RPC
    // (SECURITY DEFINER): the DB enforces that the caller is a superadmin (or
    // same-institution admin) and merges the 'admin' role. The user must exist
    // and have completed onboarding (institution set).
    const { data: target, error: findErr } = await supabase
      .from("users")
      .select("id, institution_id")
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

    const { error: updateErr } = await (
      supabase as unknown as {
        rpc(
          fn: "fn_admin_set_user_role",
          args: { p_target_user_id: string; p_role: string },
        ): Promise<{ error: { message: string } | null }>;
      }
    ).rpc("fn_admin_set_user_role", { p_target_user_id: target.id, p_role: "admin" });

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