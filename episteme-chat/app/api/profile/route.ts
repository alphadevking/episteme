// app/api/profile/route.ts
// PATCH — update the display profile + AI context fields post-onboarding.
//
// All writes are scoped to the authenticated user; the client never supplies a
// user id. The request body is validated against `settingsPatchSchema`, which
// is `.strict()`, so a field the settings form does not own — `trust_level`,
// `roles`, `is_superadmin` — is rejected outright rather than ignored.
//
// Contract (see lib/settings/schema.ts for the full rationale):
//   key absent  → leave the field alone
//   key present → write that value
//   key = null  → CLEAR the field
//
// The response always carries the freshly re-read state, so the form
// re-baselines against what is actually stored rather than against what it
// hoped it wrote. That holds even on partial failure, which is the point: the
// two tables are written separately and the user should see the truth.
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { settingsPatchSchema, formatSettingsIssue } from "@/lib/settings/schema";
import { splitSettingsPatch, mergePreferences, readSettingsValues } from "@/lib/settings/patch";

const USER_READ_COLUMNS = "first_name, last_name, display_name, phone" as const;
const CTX_READ_COLUMNS  = "programme, level, preferences" as const;

/** Re-read both rows and resolve them into the form's value shape. */
async function readCurrent(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
) {
  const [{ data: user }, { data: context }] = await Promise.all([
    supabase.from("users").select(USER_READ_COLUMNS).eq("id", userId).maybeSingle(),
    supabase.from("user_ai_context").select(CTX_READ_COLUMNS).eq("user_id", userId).maybeSingle(),
  ]);

  if (!user) return null;
  return readSettingsValues(user, context ?? null);
}

export async function PATCH(req: Request) {
  const supabase = await createSupabaseServerClient();

  // ── Auth ──────────────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Resolve public.users.id (not the auth UUID)
  const { data: profile } = await supabase
    .from("users")
    .select("id, status")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

  // Only an active account may mutate itself. A suspended user editing their
  // own programme would otherwise change what the AI retrieves for them, which
  // is exactly what the suspension is meant to stop.
  if (profile.status !== "active") {
    return NextResponse.json({ error: "Account is not active." }, { status: 403 });
  }

  // ── Parse + validate ──────────────────────────────────────────────────
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsed = settingsPatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map(formatSettingsIssue).join(" ") },
      { status: 400 },
    );
  }

  const plan = splitSettingsPatch(parsed.data);

  // Nothing to do. Not an error — echo current state so a redundant save still
  // leaves the client correctly baselined.
  if (plan.isEmpty) {
    const values = await readCurrent(supabase, profile.id);
    return NextResponse.json({ ok: true, values });
  }

  // ── Write: users ──────────────────────────────────────────────────────
  // Through fn_update_my_profile (SECURITY DEFINER), NOT a direct update.
  //
  // `public.users` is SELECT-only for `authenticated` — the same
  // contract_column_lockdown migration that locked user_ai_context. A direct
  // `.update()` here fails with "permission denied for table users". That went
  // unnoticed because the first save to hit production only changed a
  // preference, so this branch was skipped entirely.
  //
  // The RPC can write first_name / last_name / display_name / phone and nothing
  // else — email, roles, status, institution_id and is_superadmin are not
  // nameable through it.
  if (Object.keys(plan.users).length > 0) {
    const { error } = await (
      supabase as unknown as {
        rpc(fn: "fn_update_my_profile", args: { p_patch: Record<string, string | null> }):
          Promise<{ error: { message: string } | null }>;
      }
    ).rpc("fn_update_my_profile", { p_patch: plan.users });

    if (error) {
      console.error("[profile] users update failed:", error.message);
      return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
    }
  }

  // ── Write: user_ai_context ────────────────────────────────────────────
  const touchesPrefs   = Object.keys(plan.prefsSet).length > 0 || plan.prefsUnset.length > 0;
  const touchesContext = Object.keys(plan.context).length > 0;

  if (touchesPrefs || touchesContext) {
    // Written through fn_update_my_ai_context (SECURITY DEFINER), NOT with a
    // direct upsert.
    //
    // `user_ai_context` has client writes revoked from `authenticated` — the
    // table carries role / trust_level / verified, the privilege-escalation
    // vector described in lib/session-derivation.ts. A direct `.upsert()` here
    // fails with "permission denied for table user_ai_context", which is what
    // this route used to do. The service-role client would get past it and must
    // never be used for this: it would hand back the exact escalation the
    // lockdown closed. The RPC restores write access to the personalization
    // columns only, and cannot name the privileged ones.
    //
    // Requires fn_update_my_ai_context to exist — see the SQL handed over with
    // this change. SELECT is still granted, so the read below is unaffected.
    const patch: Record<string, unknown> = { ...plan.context };

    if (touchesPrefs) {
      // Read-modify-write so preference keys this form doesn't own survive.
      const { data: current } = await supabase
        .from("user_ai_context")
        .select("preferences")
        .eq("user_id", profile.id)
        .maybeSingle();

      patch.preferences = mergePreferences(
        (current?.preferences ?? {}) as Record<string, unknown>,
        plan,
      );
    }

    const { error } = await (
      supabase as unknown as {
        rpc(fn: "fn_update_my_ai_context", args: { p_patch: Record<string, unknown> }):
          Promise<{ error: { message: string } | null }>;
      }
    ).rpc("fn_update_my_ai_context", { p_patch: patch });

    if (error) {
      console.error("[profile] user_ai_context update failed:", error.message);
      // The `users` write above may already have landed. Return the real state
      // rather than pretending the whole save failed.
      const values = await readCurrent(supabase, profile.id);
      return NextResponse.json(
        { error: "Some preferences could not be saved.", values },
        { status: 500 },
      );
    }
  }

  const values = await readCurrent(supabase, profile.id);
  return NextResponse.json({ ok: true, values });
}
