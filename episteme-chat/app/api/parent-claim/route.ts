// app/api/parent-claim/route.ts
// PATCH — update claimed matric (rate-limited)
// DELETE — cancel the pending claim
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

const MAX_CORRECTIONS = 5;
const WINDOW_HOURS    = 24;

async function resolveUserId(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .maybeSingle();
  return profile?.id ?? null;
}

// PATCH /api/parent-claim — correct the matric number on a pending claim
export async function PATCH(req: Request) {
  const supabase = await createSupabaseServerClient();
  const userId   = await resolveUserId(supabase);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let newMatric: string;
  try {
    ({ newMatric } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!newMatric?.trim()) {
    return NextResponse.json({ error: "newMatric is required" }, { status: 400 });
  }

  const normalized = newMatric.trim().toUpperCase();

  // Fetch existing pending claim
  const { data: existing } = await supabase
    .from("parent_student_links")
    .select("id, correction_count, last_corrected_at, verification_status")
    .eq("parent_user_id", userId)
    .in("verification_status", ["pending", "awaiting_student_approval"])
    .is("student_user_id", null)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: "No pending claim found" }, { status: 404 });
  }

  // Rate-limit corrections
  const correctionCount  = (existing.correction_count as number) ?? 0;
  const lastCorrectedAt  = existing.last_corrected_at as string | null;
  const windowStart      = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);

  if (
    correctionCount >= MAX_CORRECTIONS &&
    lastCorrectedAt &&
    new Date(lastCorrectedAt) > windowStart
  ) {
    return NextResponse.json(
      { error: `Too many corrections. Try again after ${WINDOW_HOURS} hours.` },
      { status: 429 },
    );
  }

  const { error } = await supabase
    .from("parent_student_links")
    .update({
      claimed_matric:      normalized,
      verification_status: "pending",
      student_user_id:     null,
      verified_at:         null,
      correction_count:    correctionCount + 1,
      last_corrected_at:   new Date().toISOString(),
    })
    .eq("id", existing.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, claimedMatric: normalized });
}

// DELETE /api/parent-claim — cancel the pending claim entirely
export async function DELETE() {
  const supabase = await createSupabaseServerClient();
  const userId   = await resolveUserId(supabase);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("parent_student_links")
    .update({ verification_status: "abandoned" })
    .eq("parent_user_id", userId)
    .in("verification_status", ["pending", "awaiting_student_approval"])
    .is("student_user_id", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
