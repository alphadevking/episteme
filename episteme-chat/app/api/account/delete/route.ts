// app/api/account/delete/route.ts
// POST — self-service account deletion (soft delete).
//
// The real work and every guard live in fn_delete_my_account: it refuses for
// superadmins and for the last active admin of an institution, sets
// status='deactivated' alongside deleted_at, and writes an audit row — all in
// one transaction. This route is the HTTP shell.
//
// The typed confirmation is re-checked here rather than trusted from the UI. A
// client-only confirmation is a speed bump, not a control: this endpoint is
// reachable with a bare fetch.
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { DELETE_CONFIRMATION } from "@/lib/account/constants";

const MAX_REASON = 500;

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { confirm?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (typeof body.confirm !== "string" || body.confirm.trim() !== DELETE_CONFIRMATION) {
    return NextResponse.json(
      { error: `Type "${DELETE_CONFIRMATION}" to confirm.` },
      { status: 400 },
    );
  }

  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, MAX_REASON)
      : null;

  const { error } = await supabase.rpc("fn_delete_my_account", {
    // null is meaningful (no reason given); see the typegen note in
    // lib/hooks/use-onboarding.ts for why this is not `?? undefined`.
    p_reason: reason as unknown as string | undefined,
  });

  if (error) {
    // P0001 is a deliberate refusal from the function (superadmin, or last
    // remaining admin). Its message is written for the user, so surface it.
    const isPolicyRefusal = error.code === "P0001";
    if (!isPolicyRefusal) {
      console.error("[account/delete] failed:", error.message);
    }
    return NextResponse.json(
      { error: isPolicyRefusal ? error.message : "Could not delete the account." },
      { status: isPolicyRefusal ? 409 : 500 },
    );
  }

  // The caller signs out globally after this returns. Sessions are not revoked
  // here: every guard already rejects a non-active account, so a surviving
  // token can read nothing and write nothing.
  return NextResponse.json({ ok: true });
}
