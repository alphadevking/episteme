-- ============================================================================
-- DRAFT MIGRATION — NOT APPLIED. Review before running against production.
--
-- Status of verification (per the "critique before answering" rule in
-- ~/.claude/CLAUDE.md): the facts below were confirmed via LIVE read-only
-- queries against the `episteme` Supabase project (ref rnbrtqstjbqxsljiilny)
-- earlier in this conversation, using has_column_privilege() and
-- pg_get_functiondef() — not inferred, not guessed:
--
--   1. `users_update_own` policy: UPDATE, roles={authenticated}, USING/CHECK
--      = (auth_id = auth.uid()), with NO column restriction in the policy
--      itself (RLS policies gate rows, not columns).
--   2. `authenticated` (and `anon`) hold column-level UPDATE grants on
--      users.is_superadmin, users.primary_role, users.roles,
--      users.institution_id, users.status — confirmed via
--      has_column_privilege('authenticated', 'users', '<col>', 'UPDATE').
--   3. Same pattern on user_ai_context: authenticated/anon hold UPDATE on
--      role, trust_level, verified (policy "user_ai_context: own row only"
--      is cmd=ALL, roles={public}, ownership-only check).
--   4. fn_is_superadmin() reads users.is_superadmin directly (SECURITY
--      DEFINER, confirmed via pg_get_functiondef).
--   5. No BEFORE UPDATE trigger on either table blocks privilege-column
--      writes (trg_users_updated_at / trg_user_ai_context_updated_at only
--      stamp updated_at; trg_audit_users only logs, doesn't reject).
--
--   => Net effect right now: any authenticated user can run, via the
--      Supabase JS client (PostgREST), e.g.
--        UPDATE users SET is_superadmin = true WHERE auth_id = auth.uid();
--      and pass every guard in the app, because every guard reads a column
--      the user can write to their own row.
--
-- NOT re-verified in this pass (Supabase MCP tool was unavailable this
-- session — this migration was drafted from source-code reading only):
--   - Whether fn_redeem_invite_token is actually SECURITY DEFINER. It reads
--     as SECURITY DEFINER from its usage (client calls .rpc() on it as an
--     anon/authenticated user, and it must cross the privilege boundary to
--     assign staff/hod), and it was seen as SECURITY DEFINER in an earlier
--     live query this session — but that fact should be re-confirmed with
--     `SELECT prosecdef FROM pg_proc WHERE proname = 'fn_redeem_invite_token'`
--     before this migration ships, since a REVOKE that inadvertently starves
--     a non-DEFINER version of that function would break staff invites.
--   - Whether any other table/route legitimately writes these columns
--     beyond the four call sites identified by grepping the episteme-chat
--     source: use-onboarding.ts, verify-student/route.ts, invite-staff/
--     route.ts (service-role client, unaffected by any of this), and
--     admin/verify-student/route.ts (assumed service-role — re-check).
--
-- Scope of this migration:
--   A. Revoke UPDATE on privilege-adjacent columns from authenticated/anon
--      on `users` and `user_ai_context`.
--   B. Add fn_onboard_self() — SECURITY DEFINER — replacing the direct
--      table write in use-onboarding.ts's finalize step. Cannot assign
--      staff/admin/superadmin; institution_id/status/roles/primary_role
--      only take the validated self-serve subset.
--   C. Add fn_self_report_student() — SECURITY DEFINER — replacing the
--      direct user_ai_context write in verify-student/route.ts. Caps
--      trust_level at 2 (self-reported) and forces verified=false,
--      matching the app's existing model (trust 3+ requires the separate
--      admin-verification path, which already uses the service-role
--      client and is unaffected by this revoke).
--
-- Deliberately out of scope / unaffected:
--   - app/api/admin/invite-staff/route.ts and app/api/admin/verify-student/
--     route.ts use the service-role client (getSupabaseAdminClient()),
--     which bypasses RLS and column grants entirely — not affected by the
--     REVOKE below.
--   - app/api/profile/route.ts only writes preferences/programme/level/
--     first_name/last_name/phone — none of which are revoked here.
--   - fn_redeem_invite_token — untouched; still the only path to staff/hod.
-- ============================================================================

begin;

-- ── A. Revoke direct client writes to privilege columns ────────────────────

revoke update (is_superadmin, primary_role, roles, institution_id, status)
  on public.users
  from authenticated, anon;

revoke update (role, trust_level, verified)
  on public.user_ai_context
  from authenticated, anon;

-- ── B. Self-service onboarding, safe subset only ────────────────────────────

create or replace function public.fn_onboard_self(
  p_role          text,
  p_institution_id uuid,
  p_first_name    text,
  p_last_name     text default null,
  p_phone         text default null
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid;
  v_existing_roles user_role[];
  v_merged_roles user_role[];
begin
  -- Never allow self-service to grant staff/admin/superadmin. This is the
  -- actual boundary the app previously relied on client-side ROLES-array
  -- filtering for (components/onboarding/onboarding-wizard.tsx) — enforcing
  -- it here means the UI restriction is no longer load-bearing.
  if p_role not in ('prospective', 'student', 'parent', 'guardian') then
    raise exception 'Role % cannot be self-assigned during onboarding. Staff/HOD access requires an admin invite.', p_role
      using errcode = 'P0001';
  end if;

  select id, roles into v_user_id, v_existing_roles
  from public.users
  where auth_id = auth.uid()
    and deleted_at is null;

  if v_user_id is null then
    raise exception 'No user row found for the current session' using errcode = 'P0002';
  end if;

  v_merged_roles := (
    select array_agg(distinct r)
    from unnest(coalesce(v_existing_roles, '{}') || array[p_role::user_role]) as r
    where r <> 'prospective'
  );

  update public.users
  set institution_id = p_institution_id,
      primary_role   = p_role::user_role,
      roles          = coalesce(v_merged_roles, array[p_role::user_role]),
      first_name     = p_first_name,
      last_name      = p_last_name,
      phone          = p_phone,
      status         = 'active'
  where id = v_user_id;
end;
$$;

revoke all on function public.fn_onboard_self(text, uuid, text, text, text) from public;
grant execute on function public.fn_onboard_self(text, uuid, text, text, text) to authenticated;

-- ── C. Self-reported student verification, capped at trust_level 2 ─────────

create or replace function public.fn_self_report_student(
  p_matric_number text,
  p_institution_id uuid
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid;
begin
  select id into v_user_id
  from public.users
  where auth_id = auth.uid()
    and deleted_at is null;

  if v_user_id is null then
    raise exception 'No user row found for the current session' using errcode = 'P0002';
  end if;

  -- Self-reported claims are never auto-verified. trust_level 3+ requires
  -- app/api/admin/verify-student/route.ts (service-role client, untouched
  -- by this migration).
  insert into public.user_ai_context (user_id, trust_level, matric_number, verified)
  values (v_user_id, 2, upper(trim(p_matric_number)), false)
  on conflict (user_id) do update
    set trust_level   = case
                           when public.user_ai_context.trust_level >= 3 then public.user_ai_context.trust_level
                           else 2
                         end,
        matric_number = upper(trim(p_matric_number)),
        verified      = case
                           when public.user_ai_context.trust_level >= 3 then public.user_ai_context.verified
                           else false
                         end;
end;
$$;

revoke all on function public.fn_self_report_student(text, uuid) from public;
grant execute on function public.fn_self_report_student(text, uuid) to authenticated;

commit;

-- ============================================================================
-- Required application-code follow-up once this is applied (NOT yet made —
-- shipping this migration without these two edits will break onboarding
-- and self-reported student verification):
--
--   1. lib/hooks/use-onboarding.ts — replace the direct
--      `.from("users").update(...)` / `.from("user_profiles").upsert(...)`
--      block (finalize step) with:
--        supabase.rpc("fn_onboard_self", {
--          p_role: merged.role,
--          p_institution_id: merged.institutionId,
--          p_first_name: merged.firstName,
--          p_last_name: merged.lastName ?? null,
--          p_phone: merged.phone ?? null,
--        })
--      (user_profiles upsert, onboarding_sessions update, and
--      parent_student_links upsert are unaffected — none touch revoked
--      columns.)
--
--   2. app/api/verify-student/route.ts — replace the direct
--      `.from("user_ai_context").upsert({ trust_level: 2, ... })` block
--      with `supabase.rpc("fn_self_report_student", { p_matric_number,
--      p_institution_id })`.
--
-- Rollback: to undo the revoke only (leaving the new functions in place,
-- harmless if unused),
--   grant update (is_superadmin, primary_role, roles, institution_id, status)
--     on public.users to authenticated, anon;
--   grant update (role, trust_level, verified)
--     on public.user_ai_context to authenticated, anon;
-- ============================================================================
