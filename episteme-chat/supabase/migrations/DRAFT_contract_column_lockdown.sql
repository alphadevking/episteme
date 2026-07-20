-- ============================================================================
-- CONTRACT step of the column-lockdown coordinated release.
-- APPLY ONLY AFTER the app deploy carrying the RPC rewiring is live, or
-- onboarding / admin role+status / profile edits will break.
--
-- SUPERSEDES the column-revoke in DRAFT_lock_down_privilege_columns.sql, which
-- was INEFFECTIVE: it did `revoke update (cols) from authenticated`, but
-- authenticated holds TABLE-level INSERT/UPDATE/DELETE on both tables (verified
-- 2026-07-20). A column-level revoke is a no-op while a table-level grant
-- exists — the caller keeps writing every column via the table grant, and can
-- also INSERT a fresh row (trust_level=4) or DELETE-then-reinsert. Same class
-- of bug as the PUBLIC-grant issue caught in the EXECUTE hardening.
--
-- CORRECT PATTERN (revoke-all-then-grant-back, per column):
--   * Revoke table-level INSERT/UPDATE/DELETE from anon + authenticated.
--   * Grant back column-level privileges ONLY on the non-privilege columns the
--     app legitimately writes through an authenticated session.
-- After this, the privilege columns (users.is_superadmin/primary_role/roles/
-- institution_id/status; user_ai_context.role/trust_level/verified) are
-- writable only via the gated SECURITY DEFINER RPCs (which run as postgres and
-- bypass these grants) or service_role. anon can write neither table at all.
--
-- Column allowlist derived from the post-rewire app (grep of episteme-chat):
--   users            (UPDATE): first_name, last_name, phone     [profile route]
--   user_ai_context  (UPDATE): institution, programme, level, preferences,
--                              topics_seen, matric_number       [profile + onboarding]
--   user_ai_context  (INSERT): user_id + the 6 UPDATE columns   [profile upsert edge;
--                              onboarding's row is created by fn_onboard_self,
--                              a SECURITY DEFINER that bypasses these grants]
--
-- Not granted back (no authenticated code path writes them directly):
--   users INSERT  — user rows are created by the handle_new_user trigger
--                   (SECURITY DEFINER); admin role/status via gated RPCs.
--   users DELETE / user_ai_context DELETE — no client-initiated deletes.
-- ============================================================================

begin;

-- ── users ───────────────────────────────────────────────────────────────────
revoke insert, update, delete on public.users from anon, authenticated;
grant  update (first_name, last_name, phone) on public.users to authenticated;

-- ── user_ai_context ─────────────────────────────────────────────────────────
revoke insert, update, delete on public.user_ai_context from anon, authenticated;
grant  update (institution, programme, level, preferences, topics_seen, matric_number)
  on public.user_ai_context to authenticated;
grant  insert (user_id, institution, programme, level, preferences, topics_seen, matric_number)
  on public.user_ai_context to authenticated;

-- ── Audit-forgery close ──────────────────────────────────────────────────────
-- Once deployed, the app logs sign-in/out via fn_log_auth_event (actor derived
-- server-side) instead of calling the general fn_write_audit_log with
-- client-controlled args. Revoke direct client EXECUTE on the general logger so
-- authenticated users can no longer forge arbitrary audit entries. Internal
-- PERFORM calls from other SECURITY DEFINER functions run as postgres and are
-- unaffected. Requires the deploy carrying the fn_log_auth_event rewiring.
revoke execute on function public.fn_write_audit_log(text, text, uuid, uuid, jsonb, jsonb)
  from anon, authenticated, public;

commit;

-- ── Post-apply verification (read-only; every assertion should hold) ─────────
--   select
--     -- privilege columns NOT writable by authenticated:
--     not has_column_privilege('authenticated','public.users','is_superadmin','UPDATE') as p1,
--     not has_column_privilege('authenticated','public.users','roles','UPDATE')         as p2,
--     not has_column_privilege('authenticated','public.users','status','UPDATE')        as p3,
--     not has_column_privilege('authenticated','public.user_ai_context','trust_level','UPDATE') as p4,
--     not has_column_privilege('authenticated','public.user_ai_context','role','UPDATE')        as p5,
--     not has_column_privilege('authenticated','public.user_ai_context','trust_level','INSERT') as p6,
--     -- allowed columns STILL writable (app must keep working):
--     has_column_privilege('authenticated','public.users','first_name','UPDATE')        as p7,
--     has_column_privilege('authenticated','public.user_ai_context','programme','UPDATE') as p8,
--     has_column_privilege('authenticated','public.user_ai_context','preferences','INSERT') as p9,
--     -- anon can write neither table:
--     not has_table_privilege('anon','public.users','UPDATE')                           as p10,
--     not has_table_privilege('anon','public.user_ai_context','UPDATE')                 as p11,
--     -- service_role unaffected:
--     has_table_privilege('service_role','public.users','UPDATE')                       as p12;
-- ============================================================================
