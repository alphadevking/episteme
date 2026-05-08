// app/api/claims/[id]/status/route.ts
// Read-only claim status endpoint — used by claimStatusTool in episteme-core.
//
// Auth modes (in priority order):
//   1. Service-to-service: x-episteme-admin-key + x-episteme-user-id headers
//      Used by claimStatusTool running in episteme-core (no browser session).
//      The admin key is shared via env; user_public_id comes from the chat system prompt.
//   2. Cookie session: standard Supabase SSR session (browser calls, RLS-enforced).
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

type Params = { params: Promise<{ id: string }> };

const CLAIM_TYPE_LABELS: Record<string, string> = {
  transcript:    "Academic Transcript",
  degree:        "Degree Certificate",
  enrollment:    "Enrollment Letter",
  good_standing: "Good Standing Letter",
  attestation:   "Letter of Attestation",
};

// Creates a service-role Supabase client that bypasses RLS.
// Only used after the admin key has been validated server-side.
function serviceClient() {
  const url     = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const svcKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient<Database>(url, svcKey, { auth: { persistSession: false } });
}

type ClaimRow = {
  id: string;
  claim_type: string;
  status: string;
  is_urgent: boolean | null;
  created_at: string;
  reviewed_at: string | null;
  review_notes: string | null;
  rejection_reason: string | null;
  department: { name: string } | { name: string }[] | null;
  reviewer: { first_name: string | null; last_name: string | null } | { first_name: string | null; last_name: string | null }[] | null;
  [key: string]: unknown;
};

function formatClaim(claim: ClaimRow) {
  const dept = (Array.isArray(claim.department) ? claim.department[0] : claim.department) as
    | { name: string } | null;
  const reviewer = (Array.isArray(claim.reviewer) ? claim.reviewer[0] : claim.reviewer) as
    | { first_name: string | null; last_name: string | null } | null;
  const reviewerName = reviewer
    ? [reviewer.first_name, reviewer.last_name].filter(Boolean).join(" ") || null
    : null;
  return {
    found:            true,
    claim_id:         claim.id,
    claim_type:       CLAIM_TYPE_LABELS[claim.claim_type] ?? claim.claim_type,
    status:           claim.status,
    submitted_at:     claim.created_at,
    reviewed_at:      claim.reviewed_at ?? undefined,
    department:       dept?.name ?? undefined,
    reviewer:         reviewerName ?? undefined,
    review_notes:     claim.review_notes ?? undefined,
    rejection_reason: claim.rejection_reason ?? undefined,
    is_urgent:        claim.is_urgent,
  };
}

export async function GET(req: Request, { params }: Params) {
  const { id } = await params;

  // ── Mode 1: service-to-service (claimStatusTool in episteme-core) ──────────
  const incomingAdminKey = req.headers.get("x-episteme-admin-key");
  const expectedAdminKey = process.env.MASTRA_ADMIN_KEY;
  const serviceUserId    = req.headers.get("x-episteme-user-id");

  if (incomingAdminKey && expectedAdminKey && incomingAdminKey === expectedAdminKey) {
    if (!serviceUserId) {
      return Response.json({ found: false, message: "x-episteme-user-id header required" }, { status: 400 });
    }
    const supabase = serviceClient();
    const { data: claim } = await supabase
      .from("verification_claims")
      .select(`
        id, claim_type, status, is_urgent, created_at, reviewed_at,
        review_notes, rejection_reason, user_id,
        department:verification_claims_department_id_fkey(name),
        reviewer:users!reviewer_id(first_name, last_name)
      `)
      .eq("id", id)
      .eq("user_id", serviceUserId)   // ownership enforced in query (service role bypasses RLS)
      .maybeSingle();

    if (!claim) {
      return Response.json({ found: false, message: "Claim not found" }, { status: 404 });
    }
    return Response.json(formatClaim(claim));
  }

  // ── Mode 2: browser session (cookie auth, RLS enforced) ───────────────────
  const supabase = await createSupabaseServerClientReadOnly();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ found: false, message: "Unauthorized" }, { status: 401 });

  // RLS: users_select_own_claims — only the submitter can see their own claim
  const { data: claim } = await supabase
    .from("verification_claims")
    .select(`
      id, claim_type, status, is_urgent, created_at, reviewed_at,
      review_notes, rejection_reason,
      department:verification_claims_department_id_fkey(name),
      reviewer:users!reviewer_id(first_name, last_name)
    `)
    .eq("id", id)
    .maybeSingle();

  if (!claim) {
    return Response.json({ found: false, message: "Claim not found" }, { status: 404 });
  }

  return Response.json(formatClaim(claim as ClaimRow));
}
