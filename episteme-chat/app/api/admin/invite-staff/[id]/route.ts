// app/api/admin/invite-staff/[id]/route.ts
// DELETE — cancel a pending invite token.
// Only the issuing institution's admin can cancel their own institution's invites.
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Resolve caller's institution atomically
  const { data: adminRows, error: adminErr } = await supabase.rpc("fn_assert_active_admin");
  if (adminErr || !adminRows?.length) {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }
  const { institution_id } = adminRows[0] as { institution_id: string };

  // Only delete unredeemed tokens for this institution (RLS + explicit filter)
  const { error, count } = await supabase
    .from("invite_tokens")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("institution_id", institution_id)
    .is("redeemed_at", null);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!count) return Response.json({ error: "Invite not found or already redeemed" }, { status: 404 });

  return new Response(null, { status: 204 });
}
