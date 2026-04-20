"use client";

// Shows a student any pending parent link requests awaiting their approval.
// Self-contained — renders nothing if no requests.

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { UsersIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type PendingLink = {
  id:                string;
  relationship_type: string;
  parent: {
    first_name: string | null;
    last_name:  string | null;
    email:      string;
  } | null;
};

export function StudentApprovalBanner() {
  const supabase             = createSupabaseBrowserClient();
  const [links,   setLinks]  = useState<PendingLink[] | undefined>(undefined);
  const [busy,    setBusy]   = useState<string | null>(null); // link id being actioned

  useEffect(() => {
    supabase
      .from("parent_student_links")
      .select("id, relationship_type, parent:parent_user_id(first_name, last_name, email)")
      .eq("verification_status", "awaiting_student_approval")
      .then(({ data }) => setLinks((data as PendingLink[]) ?? []));
  }, [supabase]);

  if (!links || links.length === 0) return null;

  const respond = async (linkId: string, accept: boolean) => {
    setBusy(linkId);
    await fetch("/api/parent-claim/respond", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ linkId, accept }),
    });
    setLinks((prev) => prev?.filter((l) => l.id !== linkId));
    setBusy(null);
  };

  return (
    <div className="space-y-2">
      {links.map((link) => {
        const parentName = [link.parent?.first_name, link.parent?.last_name]
          .filter(Boolean).join(" ") || link.parent?.email || "Someone";

        return (
          <div key={link.id} className="rounded-lg border bg-card px-3 py-2.5 text-xs space-y-2">
            <div className="flex items-center gap-1.5">
              <UsersIcon className="size-3 text-muted-foreground shrink-0" />
              <span className="font-medium text-foreground">Parent link request</span>
            </div>
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">{parentName}</span> wants to link as
              your <span className="font-medium">{link.relationship_type}</span>.
            </p>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                className="h-6 text-[11px] px-2 flex-1"
                onClick={() => respond(link.id, true)}
                disabled={busy === link.id}
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[11px] px-2 flex-1"
                onClick={() => respond(link.id, false)}
                disabled={busy === link.id}
              >
                Decline
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
