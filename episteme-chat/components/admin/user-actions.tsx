// components/admin/user-actions.tsx
// Place at: components/admin/user-actions.tsx
"use client";

import { Button } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  userId: string;
  currentStatus: string;
  currentRole: string;
};

const ROLES = [
  "prospective", "student", "parent",
  "guardian", "staff", "hod", "admin",
];

export function UserActions({ userId, currentStatus, currentRole }: Props) {
  const supabase = createSupabaseBrowserClient();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState(currentRole);

  const setStatus = async (status: string) => {
    setSaving(true);
    const { error: e } = await supabase
      .from("users")
      .update({ status })
      .eq("auth_id", userId);
    setSaving(false);
    if (e) { setError(e.message); return; }
    router.refresh();
  };

  const saveRole = async () => {
    setSaving(true);
    const { error: e } = await supabase
      .from("users")
      .update({ primary_role: role, roles: [role] })
      .eq("auth_id", userId);
    setSaving(false);
    if (e) { setError(e.message); return; }
    setOpen(false);
    router.refresh();
  };

  return (
    <>
      <div className="flex items-center gap-2">
        {currentStatus === "active" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => setStatus("suspended")}
            className="text-destructive border-destructive/30 hover:bg-destructive/5"
          >
            Suspend
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => setStatus("active")}
          >
            Activate
          </Button>
        )}
        <Button size="sm" onClick={() => setOpen(true)}>
          Change role
        </Button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-xs rounded-xl border bg-card p-6 shadow-xl space-y-4">
            <h2 className="text-sm font-semibold">Change Role</h2>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r} value={r} className="capitalize">{r}</option>
              ))}
            </select>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setOpen(false); setError(null); }}
              >
                Cancel
              </Button>
              <Button size="sm" disabled={saving} onClick={saveRole}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}