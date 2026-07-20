-- ============================================================================
-- EXPAND step of the column-lockdown coordinated release (expand → deploy →
-- contract). ADDITIVE ONLY — creates/extends gated SECURITY DEFINER RPCs so
-- the app can be migrated off direct privilege-column writes. Applying this
-- breaks nothing: the old direct-write paths keep working because the column
-- grants are NOT revoked here (that is the later CONTRACT step).
--
-- Approach A (gated RPCs) chosen as gold standard: authorization lives in the
-- data layer, atomic with the write + audit, matching the existing
-- fn_admin_assign_claim / fn_admin_verify_student / fn_hod_review_claim idiom.
-- Gates fail CLOSED (learning from the fn_provision_* fail-open bug): a NULL
-- auth.uid() resolves to no caller row → 'Unauthorized', never a bypass.
--
-- All functions here are authenticated-only (never anon), consistent with the
-- deny-by-default posture applied in migration `gold_execute_hardening`.
-- ============================================================================

begin;

-- ── 1. Extend fn_onboard_self to also seed user_ai_context.role ─────────────
-- The onboarding user_ai_context upsert writes role/trust_level/verified
-- (locked columns). trust_level/verified must NEVER come from the client, so
-- they are NOT set here — they take the column defaults (trust_level=1,
-- verified=false) on insert, or are preserved on conflict. Only `role` (already
-- validated to a self-service-safe value below) is written, kept consistent
-- with users.primary_role. The app's remaining user_ai_context upsert then
-- writes only NON-locked personalization columns (institution/programme/level/
-- preferences/topics_seen/matric_number).
create or replace function public.fn_onboard_self(
  p_role           text,
  p_institution_id uuid,
  p_first_name     text,
  p_last_name      text default null,
  p_phone          text default null
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
  if p_role not in ('prospective', 'student', 'parent', 'guardian') then
    raise exception 'Role % cannot be self-assigned during onboarding. Staff/HOD access requires an admin invite.', p_role
      using errcode = 'P0001';
  end if;

  select id, roles into v_user_id, v_existing_roles
  from public.users
  where auth_id = auth.uid() and deleted_at is null;

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

  -- Seed only the locked column `role` in user_ai_context; leave trust_level /
  -- verified to defaults (never client-set). Non-locked context columns are
  -- written separately by the app.
  insert into public.user_ai_context (user_id, role)
  values (v_user_id, p_role)
  on conflict (user_id) do update set role = excluded.role;
end;
$$;

revoke all on function public.fn_onboard_self(text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_onboard_self(text, uuid, text, text, text) to authenticated;

-- ── 2. fn_self_report_student (unchanged from column-lockdown draft) ────────
create or replace function public.fn_self_report_student(
  p_matric_number  text,
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
  from public.users where auth_id = auth.uid() and deleted_at is null;

  if v_user_id is null then
    raise exception 'No user row found for the current session' using errcode = 'P0002';
  end if;

  insert into public.user_ai_context (user_id, trust_level, matric_number, verified)
  values (v_user_id, 2, upper(trim(p_matric_number)), false)
  on conflict (user_id) do update
    set trust_level   = case when public.user_ai_context.trust_level >= 3
                             then public.user_ai_context.trust_level else 2 end,
        matric_number = upper(trim(p_matric_number)),
        verified      = case when public.user_ai_context.trust_level >= 3
                             then public.user_ai_context.verified else false end;
end;
$$;

revoke all on function public.fn_self_report_student(text, uuid) from public, anon, authenticated;
grant execute on function public.fn_self_report_student(text, uuid) to authenticated;

-- ── 3. fn_admin_set_user_role — gated replacement for the direct role writes
--    in components/admin/user-actions.tsx and provision-admin-form.tsx ───────
-- Authorization mirrors the admin_all_users_in_institution RLS policy:
--   * superadmin may set any non-superadmin user's role;
--   * admin may set roles only for non-superadmin users in their own institution.
-- Never assigns 'superadmin' and never targets a superadmin. Roles are MERGED
-- (existing roles preserved, 'prospective' dropped) rather than replaced, so an
-- admin action can't silently strip a user's other roles.
create or replace function public.fn_admin_set_user_role(
  p_target_user_id uuid,
  p_role           text
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_caller_id    uuid;
  v_caller_inst  uuid;
  v_is_super     boolean;
  v_caller_status public.account_status;
  v_target       public.users;
  v_merged_roles user_role[];
begin
  select id, institution_id, is_superadmin, status
    into v_caller_id, v_caller_inst, v_is_super, v_caller_status
  from public.users where auth_id = auth.uid() and deleted_at is null;

  if v_caller_id is null then raise exception 'Unauthorized: not authenticated'; end if;
  if v_caller_status <> 'active' then raise exception 'Unauthorized: account is not active'; end if;
  if p_role = 'superadmin' then raise exception 'Cannot assign the superadmin role here'; end if;

  select * into v_target from public.users where id = p_target_user_id and deleted_at is null;
  if not found then raise exception 'Target user not found'; end if;
  if v_target.is_superadmin then raise exception 'Cannot modify a superadmin'; end if;

  if not v_is_super then
    if not fn_is_admin() then raise exception 'Unauthorized: caller is not an admin'; end if;
    if v_target.institution_id is distinct from v_caller_inst then
      raise exception 'Target user is outside your institution';
    end if;
  end if;

  v_merged_roles := (
    select array_agg(distinct r)
    from unnest(coalesce(v_target.roles, '{}') || array[p_role::user_role]) as r
    where r <> 'prospective'
  );

  update public.users
  set primary_role = p_role::user_role,
      roles        = coalesce(v_merged_roles, array[p_role::user_role]),
      updated_at   = now()
  where id = p_target_user_id;

  perform public.fn_write_audit_log(
    p_action         := 'admin_set_user_role',
    p_resource_type  := 'user',
    p_resource_id    := p_target_user_id,
    p_institution_id := v_target.institution_id,
    p_old_value      := jsonb_build_object('primary_role', v_target.primary_role, 'roles', v_target.roles),
    p_new_value      := jsonb_build_object('primary_role', p_role, 'roles', v_merged_roles)
  );
end;
$$;

revoke all on function public.fn_admin_set_user_role(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_admin_set_user_role(uuid, text) to authenticated;

-- ── 4. fn_admin_set_user_status — gated replacement for the status writes in
--    components/admin/user-actions.tsx ───────────────────────────────────────
create or replace function public.fn_admin_set_user_status(
  p_target_user_id uuid,
  p_status         text
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_caller_id     uuid;
  v_caller_inst   uuid;
  v_is_super      boolean;
  v_caller_status public.account_status;
  v_target        public.users;
begin
  select id, institution_id, is_superadmin, status
    into v_caller_id, v_caller_inst, v_is_super, v_caller_status
  from public.users where auth_id = auth.uid() and deleted_at is null;

  if v_caller_id is null then raise exception 'Unauthorized: not authenticated'; end if;
  if v_caller_status <> 'active' then raise exception 'Unauthorized: account is not active'; end if;
  -- Admin-toggleable subset of account_status. Lifecycle states set by other
  -- flows (pending_verification, archived) are deliberately not settable here.
  if p_status not in ('active','suspended','deactivated') then
    raise exception 'Invalid status % (allowed: active, suspended, deactivated)', p_status;
  end if;

  select * into v_target from public.users where id = p_target_user_id and deleted_at is null;
  if not found then raise exception 'Target user not found'; end if;
  if v_target.is_superadmin then raise exception 'Cannot modify a superadmin'; end if;

  if not v_is_super then
    if not fn_is_admin() then raise exception 'Unauthorized: caller is not an admin'; end if;
    if v_target.institution_id is distinct from v_caller_inst then
      raise exception 'Target user is outside your institution';
    end if;
  end if;

  update public.users
  set status = p_status::public.account_status, updated_at = now()
  where id = p_target_user_id;

  perform public.fn_write_audit_log(
    p_action         := 'admin_set_user_status',
    p_resource_type  := 'user',
    p_resource_id    := p_target_user_id,
    p_institution_id := v_target.institution_id,
    p_old_value      := jsonb_build_object('status', v_target.status),
    p_new_value      := jsonb_build_object('status', p_status)
  );
end;
$$;

revoke all on function public.fn_admin_set_user_status(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_admin_set_user_status(uuid, text) to authenticated;

commit;
