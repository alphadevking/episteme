// app/api/admin/verify-student/route.ts
// Admin-only endpoint to verify or reject a student's matric submission.
// All DB work is delegated to fn_admin_verify_student (SECURITY DEFINER),
// which enforces institution scope and atomically updates both
// user_student_links and user_ai_context.
//
// RACE CONDITION FIXES (Issues #3, #6):
//   - fn_assert_active_admin() replaces the two-step profile SELECT, making
//     the status + role check atomic (Issue #3).
//   - fn_admin_verify_student() now includes an idempotency guard at the DB
//     level (raises SQLSTATE 23505 if status ≠ pending/rejected), preventing
//     concurrent double-verification (Issue #6). A pre-check is also done
//     here to give a clean 409 before hitting the RPC.

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function PATCH(req: Request) {
  const supabase = await createSupabaseServerClient();

  // Step 1: validate JWT (catches revoked tokens).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Step 2: atomic role + status check. fn_assert_active_admin() verifies in
  // one query: profile exists, not deleted, status = 'active', is admin/superadmin.
  const { data: rows, error: rpcError } = await supabase.rpc("fn_assert_active_admin");
  if (rpcError || !rows || rows.length === 0) {
    const status = rpcError?.code === "P0002" ? 403 : 401;
    return NextResponse.json({ error: status === 403 ? "Forbidden" : "Unauthorized" }, { status });
  }

  // Parse and validate request body.
  let linkId: string, action: string, reason: string | undefined;
  try {
    ({ linkId, action, reason } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!linkId || !action) {
    return NextResponse.json({ error: "linkId and action are required" }, { status: 400 });
  }
  if (!["verify", "reject"].includes(action)) {
    return NextResponse.json({ error: "action must be 'verify' or 'reject'" }, { status: 400 });
  }
  if (action === "reject" && !reason?.trim()) {
    return NextResponse.json({ error: "A rejection reason is required" }, { status: 400 });
  }

  // Step 3: idempotency pre-check (application-level guard before the RPC).
  // The RPC also enforces this atomically, but checking here gives a cleaner
  // 409 response without going through the full RPC execution path.
  const { data: link } = await supabase
    .from("user_student_links")
    .select("verification_status")
    .eq("id", linkId)
    .maybeSingle();

  if (link && !["pending", "rejected"].includes(link.verification_status)) {
    return NextResponse.json(
      { error: `Conflict: link is already in status '${link.verification_status}'` },
      { status: 409 },
    );
  }

  // Step 4: delegate to the SECURITY DEFINER RPC which enforces institution
  // scope, re-checks status atomically, and applies the update.
  const { error } = await supabase.rpc("fn_admin_verify_student", {
    p_link_id: linkId,
    p_action:  action,
    p_reason:  reason?.trim() ?? null,
  });

  if (error) {
    console.error("[admin/verify-student]", error.message);
    const status = error.message.includes("Unauthorized") ? 401
                 : error.message.includes("Forbidden")    ? 403
                 : error.message.includes("not found")    ? 404
                 : error.code === "23505"                  ? 409
                 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ ok: true });
}
