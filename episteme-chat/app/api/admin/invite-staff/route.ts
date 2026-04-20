// app/api/admin/invite-staff/route.ts
// Creates an invite_tokens row (with hashed token) and returns the raw token
// for the UI to embed in the email invite link.
// The raw token NEVER touches the database — only SHA-256(token) is stored.
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createHash, randomBytes } from "crypto";

const VALID_ROLES = ["staff", "hod"] as const;
type InviteRole = (typeof VALID_ROLES)[number];

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { email, role, department_id } = body;

  if (!email || typeof email !== "string") {
    return Response.json({ error: "email is required" }, { status: 400 });
  }
  if (!role || !VALID_ROLES.includes(role as InviteRole)) {
    return Response.json({ error: "role must be 'staff' or 'hod'" }, { status: 400 });
  }
  if (role === "hod" && !department_id) {
    return Response.json({ error: "department_id is required for HOD invites" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Resolve admin's institution — fn_assert_active_admin handles auth
  const { data: adminRows, error: adminErr } = await supabase.rpc("fn_assert_active_admin");
  if (adminErr || !adminRows?.length) {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }
  const { institution_id } = adminRows[0] as { institution_id: string };

  // Resolve the inviting admin's user id
  const { data: adminUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!adminUser) return Response.json({ error: "Admin profile not found" }, { status: 403 });

  // Generate raw token (never stored), store only the hash
  const rawToken  = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  const { error: insertErr } = await supabase
    .from("invite_tokens")
    .insert({
      token_hash:     tokenHash,
      email:          email.trim().toLowerCase(),
      role:           role as InviteRole,
      institution_id,
      department_id:  department_id ? String(department_id) : null,
      invited_by:     adminUser.id,
    });

  if (insertErr) {
    // Unique constraint = pending invite already exists for this email+institution
    if (insertErr.code === "23505") {
      return Response.json(
        { error: "A pending invite already exists for this email. Cancel it first or wait for it to expire." },
        { status: 409 },
      );
    }
    return Response.json({ error: insertErr.message }, { status: 500 });
  }

  // Return the raw token — caller embeds it in the invite email link
  // e.g. https://app.example.com/onboarding/redeem?token=<rawToken>
  return Response.json({ token: rawToken }, { status: 201 });
}
