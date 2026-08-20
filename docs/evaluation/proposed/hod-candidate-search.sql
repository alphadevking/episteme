-- ============================================================================
--  PROPOSED — fn_search_hod_candidates
--
--  DRAFT. NOT APPLIED. Written against lib/types/database.ts (generated types),
--  not against a live database. Review before running.
--
--  ── WHY THIS EXISTS ────────────────────────────────────────────────────────
--  components/admin/hod-picker.tsx previously searched public.users directly
--  from the browser client, hand-building a PostgREST `or=(...)` filter string
--  to check eligibility across both primary_role and the roles[] array:
--
--    .or(`primary_role.in.(staff,hod,admin),roles.cs.{staff,hod,admin}`)
--
--  The array literal's internal commas are unquoted, which PostgREST's or()
--  parser reads as additional top-level conditions rather than part of the
--  value — a malformed filter, rejected by PostgREST. The client code only
--  destructured `{ data }` (not `error`), so the failure surfaced as a
--  silent empty result set: the UI showed "Searching…" and then nothing,
--  indistinguishable from a legitimate zero-match search.
--
--  That instance was fixed by quoting the literal (`roles.cs."{...}"`), but
--  the underlying pattern — building a filter DSL string via interpolation —
--  stays one PostgREST edge case away from breaking again. This function
--  moves the eligibility check into SQL, where p_query is a bound parameter
--  (no string-escaping surface at all) and the institution scope is derived
--  server-side rather than trusted from a client-supplied prop.
--
--  ── SECURITY ────────────────────────────────────────────────────────────
--  SECURITY DEFINER, but current_admin_institution_id() (already used by
--  other fn_admin_* RPCs in this codebase) returns NULL for a non-admin
--  caller. institution_id = NULL matches nothing, so a non-admin gets zero
--  rows rather than another institution's users — no explicit role check
--  needed beyond that, consistent with how the other search RPC in this
--  file (fn_search_institutions) is written.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_search_hod_candidates(p_query text)
RETURNS TABLE (
  id           uuid,
  email        text,
  first_name   text,
  last_name    text,
  primary_role user_role
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT u.id, u.email, u.first_name, u.last_name, u.primary_role
  FROM   public.users u
  WHERE  u.institution_id = current_admin_institution_id()
    AND  u.deleted_at IS NULL
    AND  (
           u.primary_role = ANY (ARRAY['staff','hod','admin']::user_role[])
        OR u.roles && ARRAY['staff','hod','admin']::user_role[]
         )
    AND  (
           p_query IS NULL OR length(p_query) < 2
        OR u.email      ILIKE '%' || p_query || '%'
        OR u.first_name ILIKE '%' || p_query || '%'
        OR u.last_name  ILIKE '%' || p_query || '%'
         )
  ORDER BY u.first_name NULLS LAST, u.last_name NULLS LAST
  LIMIT 8;
$$;

REVOKE ALL ON FUNCTION public.fn_search_hod_candidates(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_search_hod_candidates(text) TO authenticated;
