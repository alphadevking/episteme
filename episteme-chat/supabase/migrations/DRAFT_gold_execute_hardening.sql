-- ============================================================================
-- DRAFT MIGRATION — NOT APPLIED. Build + branch-test before prod.
--
-- Gold-standard EXECUTE hardening for public SECURITY DEFINER functions.
-- Supersedes DRAFT_urgent_fix_provisioning_anon_bypass.sql (that file remains
-- as the "apply now" triage option; this is the complete fix).
--
-- ROOT CAUSE: Supabase grants EXECUTE on every function to anon + authenticated
-- by default. Combined with SECURITY DEFINER (runs as postgres), that turned
-- two mis-gated functions into an unauthenticated path to superadmin, and
-- leaves ~12 more functions (triggers, internal helpers, scheduled jobs)
-- needlessly client-callable — including fn_write_audit_log (audit forgery).
--
-- POSTURE ESTABLISHED HERE: deny-by-default for anon. anon keeps EXECUTE ONLY
-- on the functions it legitimately needs; every other SECURITY DEFINER function
-- becomes unreachable by unauthenticated callers. Clearly-dead grants are
-- removed from authenticated too.
--
-- ── Everything below was derived from live, read-only inspection of project
--    `episteme` (rnbrtqstjbqxsljiilny) on 2026-07-19, NOT assumed: ───────────
--
-- anon allowlist (KEEP anon EXECUTE) — 8 functions:
--   * 6 RLS-helper predicates referenced inside RLS policy USING/CHECK clauses
--     (pg_policy scan): fn_is_superadmin, fn_is_admin, fn_is_staff_or_above,
--     fn_get_auth_institution_id, current_user_public_id,
--     current_admin_institution_id. Revoking these would break every
--     policy-governed query — including anon reads on public share pages.
--   * 2 public-share readers designed for unauthenticated access:
--     fn_get_public_thread_by_share_token, fn_get_public_messages_by_share_token.
--
-- Dead grants (REVOKE from BOTH anon AND authenticated) — provably not
-- client-callable:
--   * 8 trigger functions (prorettype = trigger; triggers fire without an
--     EXECUTE check, so revoking cannot break them): fn_audit_claims,
--     fn_audit_student_links, fn_audit_users, fn_handle_new_user,
--     handle_new_user, fn_notify_claim_status_change,
--     fn_reroute_claims_on_hod_change, fn_sync_student_department.
--   * scheduled/cron jobs (run as postgres/cron owner, no app .rpc() call):
--     fn_escalate_stale_claims, fn_expire_parent_claims.
--   * rls_auto_enable (internal/event helper).
--   * fn_provision_superadmin, fn_provision_admin (service_role-only; handled
--     in Section A). No app .rpc() call — verified by repo grep.
--
-- authenticated RPCs (KEEP authenticated, revoke anon) — confirmed by grep of
-- episteme-chat for .rpc("<name>"): fn_redeem_invite_token, fn_create_chat_thread,
-- fn_update_chat_thread, fn_delete_chat_thread, fn_list_my_chat_threads,
-- fn_assert_active_admin, fn_assert_active_hod, fn_get_message_feedback,
-- fn_submit_message_feedback, fn_search_institutions, fn_hod_review_claim,
-- fn_admin_reopen_claim, fn_admin_assign_claim, fn_admin_verify_student,
-- fn_validate_institution_scope, fn_write_audit_log_for_kb,
-- fn_resolve_pending_parent_claims, fn_respond_to_parent_claim,
-- fn_submit_verification_claim, fn_readonly_list_active_faculties,
-- fn_write_audit_log, fn_onboard_self*, fn_self_report_student*
--   (*created by DRAFT_lock_down_privilege_columns.sql — apply that first or
--    together; the grant loop below only touches functions that exist.)
--
-- NOTE (follow-up, not fixed here): fn_write_audit_log is called directly from
-- browser components (user-badge, hod-shell, admin-shell, auth/callback), so an
-- authenticated user can author audit entries for themselves. Audit writes
-- should move server-side / into the SECURITY DEFINER functions that already
-- PERFORM them. Tracked separately; not changed here to avoid breaking logging.
-- ============================================================================

begin;

-- ── Section A: provisioning — fail CLOSED, service_role only ────────────────
-- Gate rewritten to remove the fail-open `auth.uid() is not null and ...`
-- pattern. No null-auth bootstrap branch: superadmin #1 is seeded out-of-band
-- via service_role (one already exists in this project). Bodies otherwise
-- verbatim from production.

create or replace function public.fn_provision_superadmin(p_email text)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_caller_id uuid;
  v_target    public.users;
begin
  if not fn_is_superadmin() then
    raise exception 'permission denied: caller is not a superadmin';
  end if;

  select id into v_caller_id from public.users where auth_id = auth.uid();
  select * into v_target from public.users where email = p_email;
  if not found then raise exception 'user % not found', p_email; end if;
  if v_target.status <> 'active' then
    raise exception 'user % is not active (status: %)', p_email, v_target.status;
  end if;

  update public.users set is_superadmin = true, updated_at = now()
   where email = p_email;

  insert into public.audit_logs (actor_user_id, action, resource_type, resource_id, new_value)
  values (v_caller_id, 'provision_superadmin', 'user', v_target.id,
          jsonb_build_object('email', p_email, 'is_superadmin', true));
end;
$function$;

create or replace function public.fn_provision_admin(p_email text, p_institution_id uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_caller_id uuid;
  v_target    public.users;
begin
  if not fn_is_superadmin() then
    raise exception 'permission denied: caller is not a superadmin';
  end if;

  select id into v_caller_id from public.users where auth_id = auth.uid();
  select * into v_target from public.users where email = p_email;
  if not found then raise exception 'user % not found', p_email; end if;
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
  values (v_caller_id, 'provision_admin', 'user', v_target.id, p_institution_id,
          jsonb_build_object('email', p_email, 'primary_role', 'admin', 'institution_id', p_institution_id));
end;
$function$;

revoke execute on function public.fn_provision_superadmin(text)  from anon, authenticated, public;
revoke execute on function public.fn_provision_admin(text, uuid) from anon, authenticated, public;

-- ── Section B: deny-by-default via revoke-all-then-grant-back ────────────────
-- CRITICAL: Supabase grants EXECUTE to PUBLIC (shown as `=X/postgres` in the
-- ACL) in ADDITION to explicit anon/authenticated grants. Revoking only from
-- `anon` is a NO-OP — the caller keeps EXECUTE via PUBLIC. This was caught by a
-- transactional dry-run against prod (2026-07-19): a `revoke ... from anon`
-- loop left anon still able to execute every function. The correct pattern is
-- to strip PUBLIC + anon + authenticated from ALL SECURITY DEFINER functions,
-- then grant back explicitly. This whole 3-step block was dry-run verified to
-- produce exactly the intended map with no app/RLS breakage.
--
-- service_role holds its own explicit grant (`service_role=X`) and is never
-- revoked here, so backend/bootstrap access is preserved throughout.

-- 1. Strip ALL client-role EXECUTE (PUBLIC, anon, authenticated) from every SD fn
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

-- 2. Grant authenticated on everything EXCEPT the dead set + provisioning.
--    (Conservative: any SD function not provably internal keeps authenticated,
--    so no app RPC can break; the security win is that anon loses all of them.)
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname not in (
        -- trigger functions (EXECUTE not consulted when a trigger fires):
        'fn_audit_claims', 'fn_audit_student_links', 'fn_audit_users',
        'fn_handle_new_user', 'handle_new_user',
        'fn_notify_claim_status_change', 'fn_reroute_claims_on_hod_change',
        'fn_sync_student_department',
        -- scheduled/cron + internal helpers (no app .rpc() caller):
        'fn_escalate_stale_claims', 'fn_expire_parent_claims', 'rls_auto_enable',
        -- provisioning: service_role only:
        'fn_provision_superadmin', 'fn_provision_admin'
      )
  loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;

-- 3. Grant anon ONLY on the allowlist: the 6 RLS-helper predicates that policy
--    evaluation needs for anon (public share pages), plus the 2 public-share
--    readers. Everything else remains anon-unreachable.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname in (
        'fn_is_superadmin', 'fn_is_admin', 'fn_is_staff_or_above',
        'fn_get_auth_institution_id', 'current_user_public_id',
        'current_admin_institution_id',
        'fn_get_public_thread_by_share_token',
        'fn_get_public_messages_by_share_token'
      )
  loop
    execute format('grant execute on function %s to anon', r.sig);
  end loop;
end $$;

-- ── Section D: pin search_path on the mutable-search_path functions ──────────
-- Advisor: function_search_path_mutable. Not currently exploitable (anon/
-- authenticated cannot CREATE in public or create schemas — verified), but
-- gold standard pins it so a DEFINER function can never resolve an
-- attacker-shadowed object.
alter function public.fn_redeem_invite_token(text) set search_path = 'public';
-- Trigger helpers (SECURITY INVOKER, lower risk, but advisor-flagged):
alter function public.fn_update_updated_at() set search_path = 'public';
alter function public.set_updated_at()       set search_path = 'public';

commit;

-- ── Section E: post-apply verification (read-only; run after applying) ───────
-- Expect: every assertion returns true.
--
-- with checks as (
--   select
--     -- provisioning: no client role can execute
--     not has_function_privilege('anon','public.fn_provision_superadmin(text)','EXECUTE')          as p1,
--     not has_function_privilege('authenticated','public.fn_provision_superadmin(text)','EXECUTE') as p2,
--     has_function_privilege('service_role','public.fn_provision_superadmin(text)','EXECUTE')      as p3,
--     -- RLS helpers still reachable by anon (policies must keep working)
--     has_function_privilege('anon','public.fn_is_superadmin()','EXECUTE')                         as p4,
--     has_function_privilege('anon','public.fn_get_auth_institution_id()','EXECUTE')               as p5,
--     -- an app RPC keeps authenticated but loses anon
--     has_function_privilege('authenticated','public.fn_redeem_invite_token(text)','EXECUTE')      as p6,
--     not has_function_privilege('anon','public.fn_redeem_invite_token(text)','EXECUTE')           as p7,
--     -- a trigger function is now unreachable by clients (trigger still fires)
--     not has_function_privilege('anon','public.fn_audit_users()','EXECUTE')                       as p8,
--     not has_function_privilege('authenticated','public.fn_audit_users()','EXECUTE')              as p9,
--     -- audit-forgery surface reduced: anon can no longer write audit logs
--     not has_function_privilege('anon','public.fn_write_audit_log(text,text,uuid,uuid,jsonb,jsonb)','EXECUTE') as p10
-- )
-- select * from checks;
--
-- Plus the anon-gate proof for provisioning (must now RAISE, i.e. block):
--   begin;
--     set local role anon;
--     select set_config('request.jwt.claims', NULL, true);
--     -- expect: ERROR permission denied: caller is not a superadmin
--     select public.fn_provision_superadmin('anyone@example.com');
--   rollback;
-- ============================================================================
