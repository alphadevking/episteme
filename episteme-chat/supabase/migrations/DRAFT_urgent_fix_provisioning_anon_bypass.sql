-- ============================================================================
-- DRAFT MIGRATION — NOT APPLIED. URGENT. Review before running.
--
-- SEVERITY: Critical — unauthenticated privilege escalation to superadmin.
--
-- ── The vulnerability (proven live, read-only, against project `episteme`
--    ref rnbrtqstjbqxsljiilny on 2026-07-19) ──────────────────────────────
--
-- public.fn_provision_superadmin(p_email) and public.fn_provision_admin(
-- p_email, p_institution_id) are SECURITY DEFINER (owner postgres) and gate
-- the caller like this:
--
--     if auth.uid() is not null and not fn_is_superadmin() then
--       raise exception 'permission denied: caller is not a superadmin';
--     end if;
--
-- The guard only fires when auth.uid() IS NOT NULL. For the `anon` role
-- (an unauthenticated PostgREST request carrying only the public anon API
-- key — the key that ships in the browser bundle as
-- NEXT_PUBLIC_SUPABASE_ANON_KEY), auth.uid() is NULL, so the guard is
-- skipped entirely and execution proceeds to:
--
--     update public.users set is_superadmin = true where email = p_email;
--
-- Facts confirmed by read-only query (has_function_privilege /
-- has_schema_privilege / evaluating the gate expression under `set local
-- role anon`), NOT inferred:
--   1. anon and authenticated both hold EXECUTE on both functions.
--   2. Under role `anon` with no JWT, auth.uid() = NULL, so the gate
--      expression (auth.uid() is not null and not fn_is_superadmin())
--      evaluates to FALSE → the function does NOT raise.
--   3. The remainder of the function only requires the target email to be
--      an existing `active` user row.
--   => An attacker signs up normally (creating an active row for their own
--      email), then issues POST /rest/v1/rpc/fn_provision_superadmin with
--      body {"p_email":"<their email>"} using only the public anon key.
--      They become superadmin. No authentication required.
--
-- The full exploit (the actual UPDATE) was deliberately NOT executed — only
-- the gate expression was evaluated read-only. The three observed facts
-- above close the chain without mutating data.
--
-- Why the sibling admin functions are NOT affected: fn_admin_verify_student,
-- fn_admin_assign_claim, etc. gate with `if v_caller_id IS NULL then raise`
-- (fail CLOSED for anon). Only the two provisioning functions use the
-- fail-OPEN `auth.uid() is not null and ...` pattern. Verified by reading
-- each body.
--
-- ── Why this fix is zero-collateral ─────────────────────────────────────
-- The application never calls these two functions as RPCs. The admin-
-- provisioning UI (episteme-chat/components/admin/provision-admin-form.tsx)
-- performs a direct users UPDATE via the browser client, not an .rpc()
-- call. A full-repo grep found no `.rpc("fn_provision_superadmin")` or
-- `.rpc("fn_provision_admin")` anywhere — only generated type defs in
-- lib/types/database.ts. service_role retains EXECUTE (confirmed), so
-- backend/SQL bootstrap of the first superadmin still works.
--
-- Environment context at draft time: 4 users total, 1 existing superadmin,
-- so the first-superadmin bootstrap path is currently moot but is kept
-- fail-closed below for correctness.
-- ============================================================================

begin;

-- ── Primary fix: these are administrative/bootstrap operations and must not
--    be reachable from any client role. Only service_role (backend) may call
--    them. This single change closes the exploit. ────────────────────────────

revoke execute on function public.fn_provision_superadmin(text)      from anon, authenticated, public;
revoke execute on function public.fn_provision_admin(text, uuid)     from anon, authenticated, public;

-- ── Defense in depth: rewrite the gates to FAIL CLOSED, so the hole stays
--    shut even if EXECUTE is ever re-granted. Bodies are otherwise unchanged
--    from production (re-paste current body if it has drifted before applying).

create or replace function public.fn_provision_superadmin(p_email text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_caller_id uuid;
  v_target    public.users;
begin
  select id into v_caller_id from public.users where auth_id = auth.uid();

  -- FAIL CLOSED: require an existing superadmin caller. The ONLY exception is
  -- an unauthenticated service-role/SQL bootstrap when no superadmin exists
  -- yet (first-superadmin seeding). anon (auth.uid() IS NULL) can no longer
  -- slip through once any superadmin exists.
  if not fn_is_superadmin() then
    if not (auth.uid() is null and not exists (select 1 from public.users where is_superadmin)) then
      raise exception 'permission denied: caller is not a superadmin';
    end if;
  end if;

  select * into v_target from public.users where email = p_email;
  if not found then
    raise exception 'user % not found', p_email;
  end if;

  if v_target.status <> 'active' then
    raise exception 'user % is not active (status: %)', p_email, v_target.status;
  end if;

  update public.users
     set is_superadmin = true,
         updated_at    = now()
   where email = p_email;

  insert into public.audit_logs (actor_user_id, action, resource_type, resource_id, new_value)
  values (
    v_caller_id,
    'provision_superadmin',
    'user',
    v_target.id,
    jsonb_build_object('email', p_email, 'is_superadmin', true)
  );
end;
$function$;

create or replace function public.fn_provision_admin(p_email text, p_institution_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_caller_id uuid;
  v_target    public.users;
begin
  select id into v_caller_id from public.users where auth_id = auth.uid();

  -- FAIL CLOSED: only an existing superadmin may provision admins. No
  -- unauthenticated bootstrap branch here — admins are always provisioned by
  -- a superadmin, which exists by the time admin provisioning is used.
  if not fn_is_superadmin() then
    raise exception 'permission denied: caller is not a superadmin';
  end if;

  select * into v_target from public.users where email = p_email;
  if not found then
    raise exception 'user % not found', p_email;
  end if;

  if v_target.status <> 'active' then
    raise exception 'user % is not active (status: %)', p_email, v_target.status;
  end if;

  if not exists (select 1 from public.institutions where id = p_institution_id) then
    raise exception 'institution % not found', p_institution_id;
  end if;

  update public.users
     set primary_role   = 'admin',
         roles          = array(select distinct unnest(roles || array['admin'::public.user_role])),
         institution_id = p_institution_id,
         updated_at     = now()
   where email = p_email;

  insert into public.audit_logs (actor_user_id, action, resource_type, resource_id, institution_id, new_value)
  values (
    v_caller_id,
    'provision_admin',
    'user',
    v_target.id,
    p_institution_id,
    jsonb_build_object('email', p_email, 'primary_role', 'admin', 'institution_id', p_institution_id)
  );
end;
$function$;

-- Re-assert the revoke: CREATE OR REPLACE preserves existing grants, and the
-- default-privilege system may re-grant EXECUTE to PUBLIC on (re)creation,
-- so revoke again after redefining to be certain.
revoke execute on function public.fn_provision_superadmin(text)  from anon, authenticated, public;
revoke execute on function public.fn_provision_admin(text, uuid) from anon, authenticated, public;

commit;

-- ── Post-apply verification (run read-only after applying) ──────────────────
--   select
--     has_function_privilege('anon','public.fn_provision_superadmin(text)','EXECUTE')          as anon_super,   -- expect false
--     has_function_privilege('authenticated','public.fn_provision_superadmin(text)','EXECUTE') as auth_super,   -- expect false
--     has_function_privilege('service_role','public.fn_provision_superadmin(text)','EXECUTE')  as svc_super,    -- expect true
--     has_function_privilege('anon','public.fn_provision_admin(text,uuid)','EXECUTE')          as anon_admin,   -- expect false
--     has_function_privilege('authenticated','public.fn_provision_admin(text,uuid)','EXECUTE') as auth_admin;   -- expect false
--
-- Rollback (only if a client genuinely needs to call these — not recommended;
-- prefer keeping them service_role-only):
--   grant execute on function public.fn_provision_superadmin(text)  to authenticated;
--   grant execute on function public.fn_provision_admin(text, uuid) to authenticated;
-- ============================================================================
