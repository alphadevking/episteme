// components/admin/invite-staff-form.tsx
// Invite a new staff member or HOD from the department detail page.
// Sends to /api/admin/invite-staff, gets back a raw token, shows the
// invite link for the admin to copy/send manually (email sending is out of scope here).
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserPlusIcon, CopyIcon, CheckIcon } from "lucide-react";
import { toast } from "sonner";

type Props = {
  departmentId:   string;
  departmentName: string;
};

export function InviteStaffForm({ departmentId, departmentName }: Props) {
  const [open,      setOpen]      = useState(false);
  const [email,     setEmail]     = useState("");
  const [role,      setRole]      = useState<"staff" | "hod">("hod");
  const [saving,    setSaving]    = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied,    setCopied]    = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const reset = () => {
    setEmail(""); setRole("hod"); setInviteUrl(null);
    setCopied(false); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);

    const res = await fetch("/api/admin/invite-staff", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        email,
        role,
        department_id: role === "hod" ? departmentId : undefined,
      }),
    });

    const json = await res.json();
    setSaving(false);

    if (!res.ok) {
      setError(json.error ?? "Failed to create invite.");
      return;
    }

    // Build the redemption URL
    const base = typeof window !== "undefined" ? window.location.origin : "";
    setInviteUrl(`${base}/onboarding/redeem?token=${json.token}`);
    toast.success("Invite created.");
  };

  const copy = async () => {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="sm" variant="outline" className="gap-1.5">
        <UserPlusIcon className="size-3.5" />
        Invite Staff
      </Button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-xl">

        <h2 className="text-base font-semibold mb-0.5">Invite Staff</h2>
        <p className="text-sm text-muted-foreground mb-5">
          Sending invite for{" "}
          <span className="font-medium text-foreground">{departmentName}</span>.
        </p>

        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Invite link result */}
        {inviteUrl ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Invite link — valid for 72 hours</Label>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={inviteUrl}
                  className="font-mono text-xs h-9"
                />
                <Button size="sm" variant="outline" className="shrink-0 gap-1.5 h-9" onClick={copy}>
                  {copied
                    ? <><CheckIcon className="size-3.5 text-success" /> Copied</>
                    : <><CopyIcon className="size-3.5" /> Copy</>
                  }
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Send this link to the staff member. They must sign up first, then click the
              link to redeem their role assignment.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={reset}>Invite another</Button>
              <Button size="sm" onClick={() => { reset(); setOpen(false); }}>Done</Button>
            </div>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Email address *</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="staff@institution.edu"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">Role *</Label>
              <div className="flex gap-2">
                {(["hod", "staff"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRole(r)}
                    className={[
                      "flex-1 rounded-md border py-2 text-sm font-medium transition-colors",
                      role === r
                        ? "border-primary bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:border-primary/30",
                    ].join(" ")}
                  >
                    {r === "hod" ? "Head of Dept (HOD)" : "Staff"}
                  </button>
                ))}
              </div>
              {role === "hod" && (
                <p className="text-xs text-muted-foreground">
                  This person will be assigned as HOD of{" "}
                  <span className="font-medium text-foreground">{departmentName}</span> on redemption.
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => { reset(); setOpen(false); }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !email.trim()}>
                {saving ? "Creating…" : "Create Invite"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
