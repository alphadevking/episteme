// app/api/claims/route.ts
// User-facing claim submission endpoint.
// Delegates to fn_submit_verification_claim — a SECURITY DEFINER RPC that
// resolves the caller, auto-routes academic claims to the HOD when possible,
// and writes a full audit log row atomically.
import { createSupabaseServerClient } from "@/lib/supabase/server";

const VALID_TYPES = ["transcript", "degree", "enrollment", "good_standing", "attestation"] as const;
type ClaimType = (typeof VALID_TYPES)[number];

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { claim_type, details, is_urgent, deadline } = body;

  if (!claim_type || !VALID_TYPES.includes(claim_type as ClaimType)) {
    return Response.json({ error: "Invalid claim type" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase.rpc("fn_submit_verification_claim", {
    p_claim_type:   claim_type as ClaimType,
    p_details:      (typeof details === "object" && details !== null) ? details : {},
    p_requirements: {},
    p_is_urgent:    Boolean(is_urgent),
    p_deadline:     typeof deadline === "string" && deadline ? deadline : null,
  });

  if (error) {
    const status = error.code === "P0001" ? 401
                 : error.code === "P0003" ? 403
                 : 500;
    return Response.json({ error: error.message }, { status });
  }

  // data is the JSONB returned by the function: { id, routed, routing_note }
  const result = data as { id: string; routed: boolean; routing_note: string };
  return Response.json({ id: result.id, routed: result.routed }, { status: 201 });
}
