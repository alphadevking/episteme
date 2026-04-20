// components/admin/claim-assign-panel.tsx
// Admin assigns a pending claim to a department (and its HOD) via fn_admin_assign_claim.
"use client";

import { Button } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserCheckIcon } from "lucide-react";

type Department = {
  id:          string;
  name:        string;
  hod_user_id: string | null;
  hod: {
    id:         string;
    first_name: string | null;
    last_name:  string | null;
    email:      string;
  } | null;
};

type Props = {
  claimId:     string;
  departments: Department[];
};

export function ClaimAssignPanel({ claimId, departments }: Props) {
  const supabase = createSupabaseBrowserClient();
  const router   = useRouter();

  const [selectedId, setSelectedId] = useState("");
  const [saving,     setSaving]     = useState(false);

  // Only show departments that have an HOD assigned
  const assignable = departments.filter((d) => d.hod_user_id && d.hod);
  const selected   = assignable.find((d) => d.id === selectedId);

  const assign = async () => {
    if (!selected?.hod_user_id) return;
    setSaving(true);

    const { error } = await supabase.rpc("fn_admin_assign_claim", {
      p_claim_id:      claimId,
      p_hod_user_id:   selected.hod_user_id,
      p_department_id: selected.id,
    });

    setSaving(false);
    if (error) { toast.error(error.message); return; }

    toast.success("Claim assigned to HOD.");
    router.refresh();
  };

  return (
    <div className="rounded-lg border bg-card p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Assign to Department</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Route this claim to a department HOD for review.
        </p>
      </div>

      {assignable.length === 0 ? (
        <p className="text-sm text-muted-foreground rounded-md bg-muted/50 px-3 py-2.5">
          No departments with an assigned HOD found. Set up HODs in the Departments page first.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Department
            </label>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            >
              <option value="">Select a department…</option>
              {assignable.map((d) => {
                const hodName =
                  [d.hod?.first_name, d.hod?.last_name].filter(Boolean).join(" ") ||
                  d.hod?.email ||
                  "HOD";
                return (
                  <option key={d.id} value={d.id}>
                    {d.name} — {hodName}
                  </option>
                );
              })}
            </select>
          </div>

          {selected?.hod && (
            <div className="flex items-center gap-2.5 rounded-md bg-muted/50 px-3 py-2.5">
              <UserCheckIcon className="size-4 text-primary shrink-0" />
              <div>
                <p className="text-sm font-medium">
                  {[selected.hod.first_name, selected.hod.last_name]
                    .filter(Boolean)
                    .join(" ") || "—"}
                </p>
                <p className="text-xs text-muted-foreground">{selected.hod.email}</p>
              </div>
            </div>
          )}

          <Button
            size="sm"
            disabled={saving || !selectedId}
            onClick={assign}
            className="w-full"
          >
            {saving ? "Assigning…" : "Assign Claim"}
          </Button>
        </>
      )}
    </div>
  );
}
