// app/api/parent-claim/respond/route.ts
// Student accepts or rejects a parent link request
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let linkId: string, accept: boolean;
  try {
    ({ linkId, accept } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!linkId || typeof accept !== "boolean") {
    return NextResponse.json({ error: "linkId and accept (boolean) are required" }, { status: 400 });
  }

  const { error } = await supabase.rpc("fn_respond_to_parent_claim", {
    p_link_id: linkId,
    p_accept:  accept,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
