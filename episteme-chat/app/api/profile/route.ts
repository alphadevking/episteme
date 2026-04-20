// app/api/profile/route.ts
// PATCH — update display profile + AI context fields post-onboarding.
// All writes are scoped to the authenticated user — never trust client-supplied user IDs.
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

const ALLOWED_VERBOSITY = ["concise", "detailed"] as const;
type Verbosity = (typeof ALLOWED_VERBOSITY)[number];

function isVerbosity(v: unknown): v is Verbosity {
  return ALLOWED_VERBOSITY.includes(v as Verbosity);
}

export async function PATCH(req: Request) {
  const supabase = await createSupabaseServerClient();

  // ── Auth ──────────────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Resolve public.users.id (not auth UUID)
  const { data: profile } = await supabase
    .from("users")
    .select("id, primary_role")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

  // ── Parse + validate body ─────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const {
    firstName,
    lastName,
    phone,
    programme,
    level,
    department,
    staffTitle,
    verbosity,
  } = body as Record<string, unknown>;

  // Validate types (only allow strings; reject anything suspicious)
  const strOrNull = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  const cleanFirstName  = strOrNull(firstName);
  const cleanLastName   = strOrNull(lastName);
  const cleanPhone      = strOrNull(phone);
  const cleanProgramme  = strOrNull(programme);
  const cleanLevel      = strOrNull(level);
  const cleanDepartment = strOrNull(department);
  const cleanStaffTitle = strOrNull(staffTitle);
  const cleanVerbosity  = isVerbosity(verbosity) ? verbosity : null;

  // At least one field must be present
  const hasUserUpdate = cleanFirstName || cleanLastName || cleanPhone;
  const hasCtxUpdate  = cleanProgramme || cleanLevel || cleanDepartment ||
                        cleanStaffTitle || cleanVerbosity;

  if (!hasUserUpdate && !hasCtxUpdate) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  // ── Update users table ────────────────────────────────────────────────
  if (hasUserUpdate) {
    const userPatch: Record<string, string | null> = {};
    if (cleanFirstName !== null) userPatch.first_name = cleanFirstName;
    if (cleanLastName  !== null) userPatch.last_name  = cleanLastName;
    if (cleanPhone     !== null) userPatch.phone       = cleanPhone;

    const { error: userErr } = await supabase
      .from("users")
      .update(userPatch)
      .eq("id", profile.id);

    if (userErr) {
      console.error("[profile] users update failed:", userErr.message);
      return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
    }
  }

  // ── Update user_ai_context ────────────────────────────────────────────
  if (hasCtxUpdate) {
    // Read current preferences so we patch rather than replace the whole object
    const { data: current } = await supabase
      .from("user_ai_context")
      .select("preferences")
      .eq("user_id", profile.id)
      .maybeSingle();

    const existingPrefs = (current?.preferences ?? {}) as Record<string, unknown>;

    const newPrefs: Record<string, unknown> = { ...existingPrefs };
    if (cleanVerbosity)  newPrefs.verbosity  = cleanVerbosity;
    if (cleanDepartment) newPrefs.department  = cleanDepartment;
    if (cleanStaffTitle) newPrefs.staffTitle  = cleanStaffTitle;

    const ctxPatch: Record<string, unknown> = { preferences: newPrefs };
    if (cleanProgramme  !== null) ctxPatch.programme = cleanProgramme;
    if (cleanLevel      !== null) ctxPatch.level      = cleanLevel;

    const { error: ctxErr } = await supabase
      .from("user_ai_context")
      .upsert({ user_id: profile.id, ...ctxPatch }, { onConflict: "user_id" });

    if (ctxErr) {
      console.error("[profile] user_ai_context update failed:", ctxErr.message);
      return NextResponse.json({ error: "Failed to update AI context" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
