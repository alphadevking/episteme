// app/claims/page.tsx
// User's claim history + HOD review inbox (if HOD role).
import { getAuthContext, getServerSupabase } from "@/lib/supabase/server-auth";
import { StatusBadge } from "@/components/admin/status-badge";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PlusIcon, InboxIcon } from "lucide-react";

const CLAIM_LABELS: Record<string, string> = {
  transcript:    "Transcript",
  degree:        "Degree Certificate",
  enrollment:    "Enrollment Letter",
  good_standing: "Good Standing Letter",
  attestation:   "Letter of Attestation",
};

type ClaimRow = {
  id:         string;
  claim_type: string;
  status:     string;
  is_urgent:  boolean;
  created_at: string;
  reviewed_at: string | null;
};

export default async function ClaimsPage() {
  // Request-cached — reuses the claims layout's auth call and profile row.
  const [supabase, { user, profile }] = await Promise.all([
    getServerSupabase(),
    getAuthContext(),
  ]);

  if (!user)    return null;
  if (!profile) return null;

  const isHod = (profile.roles as string[])?.includes("hod");

  // Own submitted claims
  const { data: myClaims } = await supabase
    .from("verification_claims")
    .select("id, claim_type, status, is_urgent, created_at, reviewed_at")
    .eq("user_id", profile.id)
    .order("created_at", { ascending: false });

  // HOD review inbox — claims assigned to this user
  let hodInbox: ClaimRow[] = [];
  if (isHod) {
    const { data } = await supabase
      .from("verification_claims")
      .select("id, claim_type, status, is_urgent, created_at, reviewed_at")
      .eq("assigned_to", profile.id)
      .eq("status", "in_review")
      .order("created_at", { ascending: true });
    hodInbox = (data ?? []) as ClaimRow[];
  }

  return (
    <div className="space-y-8">

      {/* HOD inbox */}
      {isHod && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <InboxIcon className="size-4 text-primary" />
              <h2 className="font-serif text-base font-semibold">Pending Your Review</h2>
              {hodInbox.length > 0 && (
                <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  {hodInbox.length}
                </span>
              )}
            </div>
          </div>

          {hodInbox.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-center">
              <p className="text-sm text-muted-foreground">No claims pending your review.</p>
            </div>
          ) : (
            <div className="divide-y rounded-lg border bg-card overflow-hidden">
              {hodInbox.map((c) => (
                <Link
                  key={c.id}
                  href={`/claims/${c.id}`}
                  className="flex items-center justify-between px-4 py-3.5 hover:bg-muted/40 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {c.is_urgent && <span className="text-xs">🔴</span>}
                    <div>
                      <p className="text-sm font-medium">
                        {CLAIM_LABELS[c.claim_type] ?? c.claim_type}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Submitted {new Date(c.created_at).toLocaleDateString("en-US", {
                          month: "short", day: "numeric", year: "numeric",
                        })}
                      </p>
                    </div>
                  </div>
                  <StatusBadge value={c.status} />
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {/* My submitted claims */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-base font-semibold">My Claims</h2>
          <Link href="/claims/new">
            <Button size="sm" className="h-8 text-xs gap-1.5">
              <PlusIcon className="size-3.5" />
              New claim
            </Button>
          </Link>
        </div>

        {(myClaims ?? []).length === 0 ? (
          <div className="rounded-lg border border-dashed bg-muted/20 p-10 text-center space-y-3">
            <p className="text-sm font-medium">No claims yet</p>
            <p className="text-sm text-muted-foreground max-w-[36ch] mx-auto">
              Submit a verification claim to request official documents from your institution.
            </p>
            <Link href="/claims/new">
              <Button size="sm" className="mt-2">
                <PlusIcon className="size-3.5 mr-1.5" />
                Submit your first claim
              </Button>
            </Link>
          </div>
        ) : (
          <div className="divide-y rounded-lg border bg-card overflow-hidden">
            {(myClaims as ClaimRow[]).map((c) => (
              <Link
                key={c.id}
                href={`/claims/${c.id}`}
                className="flex items-center justify-between px-4 py-3.5 hover:bg-muted/40 transition-colors"
              >
                <div className="flex items-center gap-3">
                  {c.is_urgent && <span className="text-xs">🔴</span>}
                  <div>
                    <p className="text-sm font-medium">
                      {CLAIM_LABELS[c.claim_type] ?? c.claim_type}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Submitted {new Date(c.created_at).toLocaleDateString("en-US", {
                        month: "short", day: "numeric", year: "numeric",
                      })}
                      {c.reviewed_at && (
                        <> · Reviewed {new Date(c.reviewed_at).toLocaleDateString("en-US", {
                          month: "short", day: "numeric",
                        })}</>
                      )}
                    </p>
                  </div>
                </div>
                <StatusBadge value={c.status} />
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
