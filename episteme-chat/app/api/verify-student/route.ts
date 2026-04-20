// app/api/verify-student/route.ts
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

const MAX_ATTEMPTS = 3;
const WINDOW_HOURS = 24;

// Accepts:
//   Undergrad:      YY/FACULTY[/DEPT]/NNN   e.g. 19/ENG/EEE/001 | 21/MED/001
//   Postgraduate:   PG/DEPTCODE[YEARSEQ]    e.g. PG/PSC201254  | PG/PSC/001
//   Other prefixes: EXT, PRE, etc.
const MATRIC_REGEX = /^([A-Z]{1,5}|\d{2})(\/[A-Z0-9]{1,20}){1,4}$/i;

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let matricNumber: string, institutionId: string;
  try {
    ({ matricNumber, institutionId } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!matricNumber?.trim() || !institutionId?.trim()) {
    return NextResponse.json(
      { error: "matricNumber and institutionId are required" },
      { status: 400 },
    );
  }

  const normalized = matricNumber.trim().toUpperCase();

  if (!MATRIC_REGEX.test(normalized)) {
    return NextResponse.json(
      {
        error:
          "Invalid matric number format. " +
          "Examples: 19/ENG/EEE/001 (undergrad) or PG/PSC201254 (postgraduate)",
      },
      { status: 422 },
    );
  }

  // Resolve public.users.id from auth.uid
  const { data: profile } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!profile) {
    return NextResponse.json({ error: "User profile not found" }, { status: 404 });
  }

  // ── Rate-limit + existing link check ───────────────────────────────────

  const { data: existing } = await supabase
    .from("user_student_links")
    .select("id, attempt_count, last_attempt_at, trust_level, verification_method, verification_status")
    .eq("user_id", profile.id)
    .eq("institution_id", institutionId)
    .maybeSingle();

  if (existing) {
    // Already admin-verified or above — idempotent success
    if (existing.trust_level >= 3) {
      return NextResponse.json({
        trustLevel: existing.trust_level,
        method: existing.verification_method,
        matricNumber: normalized,
      });
    }

    // Rate limit window (only applies when pending, not when re-submitting after rejection)
    const windowStart = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);
    if (
      (existing as { verification_status?: string }).verification_status !== "rejected" &&
      existing.attempt_count >= MAX_ATTEMPTS &&
      existing.last_attempt_at &&
      new Date(existing.last_attempt_at) > windowStart
    ) {
      return NextResponse.json(
        { error: `Too many attempts. Please try again after ${WINDOW_HOURS} hours.` },
        { status: 429 },
      );
    }
  }

  // ── Upsert the claim at trust_level 2 (self-reported) ─────────────────

  const { error: upsertErr } = await supabase
    .from("user_student_links")
    .upsert(
      {
        user_id: profile.id,
        institution_id: institutionId,
        matric_number: normalized,
        trust_level: 2,
        verification_method: "self_reported",
        verification_status: "pending",
        rejection_reason: null,
        attempt_count: (existing?.attempt_count ?? 0) + 1,
        last_attempt_at: new Date().toISOString(),
      },
      { onConflict: "user_id,institution_id" },
    );

  if (upsertErr) {
    console.error("[verify-student] upsert failed:", upsertErr.message);
    return NextResponse.json({ error: "Failed to record verification" }, { status: 500 });
  }

  // ── Mirror trust level into user_ai_context for fast chat-route reads ─
  // Non-fatal — chat route falls back gracefully if this lags behind.

  supabase
    .from("user_ai_context")
    .upsert(
      {
        user_id: profile.id,   // public.users.id, not auth UUID
        trust_level: 2,
        matric_number: normalized,
        verified: false,
      },
      { onConflict: "user_id" },
    )
    .then(({ error: e }) => {
      if (e) console.warn("[verify-student] user_ai_context sync skipped:", e.message);
    });

  // ── Resolve any pending parent claims for this matric ─────────────────
  supabase
    .rpc("fn_resolve_pending_parent_claims", {
      p_matric: normalized,
      p_user_id: profile.id,
    })
    .then(({ error: e }) => {
      if (e) console.warn("[verify-student] parent claim resolve skipped:", e.message);
    });

  // ── TODO: enqueue background portal check ─────────────────────────────
  // When implemented, the portal check job will:
  //   1. Call UNIBEN eportal with the matric number
  //   2. On match: update trust_level → 3, verification_method → 'portal_check'
  //               update user_ai_context.trust_level → 3, verified → true
  //   3. On mismatch: leave at level 2, store portal_response for audit
  //
  // Plug-in point for future SSO:
  //   SAMLAssertionStrategy sets trust_level → 4, idp_sub, idp_provider
  //   and calls the same user_ai_context update path.
  //
  // triggerPortalCheck({ userId: profile.id, institutionId, matricNumber: normalized });

  return NextResponse.json({
    trustLevel: 2,
    method: "self_reported",
    matricNumber: normalized,
  });
}
