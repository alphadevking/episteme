-- ============================================================================
-- Regression suite for the SECURITY DEFINER EXECUTE-hardening posture.
-- Run post-apply on any environment (branch or prod). Portable (no pgTAP
-- dependency): each assertion RAISEs EXCEPTION on failure, so a clean run =
-- all green, and any regression aborts with the failing assertion name.
--
-- Usage (psql or Supabase SQL editor / MCP execute_sql):
--   \i supabase/tests/verify_execute_hardening.sql
-- Exit/behaviour: prints 'ALL EXECUTE-HARDENING ASSERTIONS PASSED' or raises.
-- ============================================================================
do $$
declare
  failures text[] := '{}';
begin
  -- ── Section A: provisioning is service_role-only, fail-closed ─────────────
  if has_function_privilege('anon','public.fn_provision_superadmin(text)','EXECUTE')
    then failures := failures || 'anon can EXECUTE fn_provision_superadmin'; end if;
  if has_function_privilege('authenticated','public.fn_provision_superadmin(text)','EXECUTE')
    then failures := failures || 'authenticated can EXECUTE fn_provision_superadmin'; end if;
  if not has_function_privilege('service_role','public.fn_provision_superadmin(text)','EXECUTE')
    then failures := failures || 'service_role LOST EXECUTE on fn_provision_superadmin'; end if;
  if has_function_privilege('anon','public.fn_provision_admin(text,uuid)','EXECUTE')
    then failures := failures || 'anon can EXECUTE fn_provision_admin'; end if;
  if has_function_privilege('authenticated','public.fn_provision_admin(text,uuid)','EXECUTE')
    then failures := failures || 'authenticated can EXECUTE fn_provision_admin'; end if;

  -- ── Section B: anon deny-by-default, with the 8-function allowlist intact ──
  -- RLS-helper predicates MUST stay anon-executable or policy eval breaks:
  if not has_function_privilege('anon','public.fn_is_superadmin()','EXECUTE')
    then failures := failures || 'RLS helper fn_is_superadmin lost anon EXECUTE'; end if;
  if not has_function_privilege('anon','public.fn_is_admin()','EXECUTE')
    then failures := failures || 'RLS helper fn_is_admin lost anon EXECUTE'; end if;
  if not has_function_privilege('anon','public.fn_is_staff_or_above()','EXECUTE')
    then failures := failures || 'RLS helper fn_is_staff_or_above lost anon EXECUTE'; end if;
  if not has_function_privilege('anon','public.fn_get_auth_institution_id()','EXECUTE')
    then failures := failures || 'RLS helper fn_get_auth_institution_id lost anon EXECUTE'; end if;
  if not has_function_privilege('anon','public.current_user_public_id()','EXECUTE')
    then failures := failures || 'RLS helper current_user_public_id lost anon EXECUTE'; end if;
  if not has_function_privilege('anon','public.current_admin_institution_id()','EXECUTE')
    then failures := failures || 'RLS helper current_admin_institution_id lost anon EXECUTE'; end if;

  -- A representative authenticated RPC keeps authenticated, loses anon:
  if not has_function_privilege('authenticated','public.fn_redeem_invite_token(text)','EXECUTE')
    then failures := failures || 'fn_redeem_invite_token lost authenticated EXECUTE (breaks staff invites)'; end if;
  if has_function_privilege('anon','public.fn_redeem_invite_token(text)','EXECUTE')
    then failures := failures || 'fn_redeem_invite_token still anon-executable'; end if;
  if not has_function_privilege('authenticated','public.fn_create_chat_thread','EXECUTE')
    then failures := failures || 'fn_create_chat_thread lost authenticated EXECUTE (breaks chat)'; end if;

  -- ── Section C: internal/trigger functions unreachable by all client roles ─
  if has_function_privilege('anon','public.fn_audit_users()','EXECUTE')
    then failures := failures || 'trigger fn_audit_users still anon-executable'; end if;
  if has_function_privilege('authenticated','public.fn_audit_users()','EXECUTE')
    then failures := failures || 'trigger fn_audit_users still authenticated-executable'; end if;
  if has_function_privilege('anon','public.rls_auto_enable()','EXECUTE')
    then failures := failures || 'rls_auto_enable still anon-executable'; end if;

  -- ── Section D: search_path pinned on the previously-mutable functions ─────
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='fn_redeem_invite_token'
      and p.proconfig is not null
      and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
  ) then failures := failures || 'fn_redeem_invite_token search_path still not pinned'; end if;

  if array_length(failures,1) is not null then
    raise exception E'EXECUTE-HARDENING REGRESSIONS:\n  - %', array_to_string(failures, E'\n  - ');
  end if;

  raise notice 'ALL EXECUTE-HARDENING ASSERTIONS PASSED';
end $$;

-- ── Negative test: as anon, provisioning must RAISE (not silently succeed) ───
-- Run separately (own transaction) so the role switch is isolated. Expected
-- result: ERROR 'permission denied: caller is not a superadmin'. If it does
-- NOT error, the hole is open.
--
-- begin;
--   set local role anon;
--   select set_config('request.jwt.claims', NULL, true);
--   select public.fn_provision_superadmin('canary@example.com');  -- must ERROR
-- rollback;
