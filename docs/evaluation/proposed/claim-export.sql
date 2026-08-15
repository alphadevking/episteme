-- ============================================================================
--  PROPOSED — claim export for workflow-replay
--
--  DRAFT. NOT RUN. Written against lib/types/database.ts (generated types), not
--  against a live database. Run it read-only and eyeball the first few rows
--  before wiring it to anything.
--
--  Feeds src/evals/claim-history.ts, whose claimHistoryFromRow() maps each row
--  to a ClaimHistory for src/evals/workflow-replay.ts. Column names below match
--  the ClaimRow interface exactly, so no translation layer sits between the
--  query and the mapper to get subtly wrong.
--
--  ── RUN THIS WITH A SERVICE-ROLE CLIENT ────────────────────────────────────
--  Under RLS this returns only the rows the caller may see, and a control
--  result over a partial population is not evidence — it is the same
--  vacuous-green failure this project has already produced twice. Pass
--  scope: 'full' to replayAll ONLY when the connection genuinely bypassed RLS;
--  pass 'rls-limited' otherwise and formatReplay will warn above every figure.
--
--  ── WHY NOT audit_logs ─────────────────────────────────────────────────────
--  audit_logs would be the richer source: an actor and timestamp per change,
--  including repeats. It is not used because its claim-transition shape cannot
--  be established from outside the database. The only audit writes visible in
--  the application are fn_write_audit_log_for_kb, for knowledge-base actions.
--  The claim RPCs are SECURITY DEFINER and may log internally, but neither the
--  `action` vocabulary nor whether `new_value` carries the status is knowable
--  from the client. Building on an assumed shape would yield an empty or wrong
--  history that reads as a clean audit.
--
--  Section 3 below is the query to run FIRST to settle that question.
-- ============================================================================


-- ── 1. THE EXPORT ──────────────────────────────────────────────────────────
-- One row per claim, with the two enrichment values workflow-replay needs:
-- the reviewer's own institution (authority-scope control) and the configured
-- SLA (so the harness measures against the agreed threshold, not an invented
-- constant).

SELECT
  c.id,
  c.user_id,
  c.claim_type,
  c.institution_id,
  c.department_id,
  c.assigned_by,
  c.assigned_to,
  c.reviewer_id,
  c.auto_routed,
  c.status,
  c.created_at,
  c.assigned_at,
  c.reviewed_at,
  c.updated_at,

  -- Enrichment. LEFT JOIN deliberately: a reviewer whose institution cannot be
  -- resolved must arrive as NULL so claimHistoryFromRow leaves it null and the
  -- scope control SKIPS. An INNER JOIN would silently drop those claims from
  -- the population, which is worse than not checking them — it would hide them.
  ru.institution_id AS reviewer_institution_id,
  sla.hod_sla_hours AS sla_hours

FROM       public.verification_claims c
LEFT JOIN  public.users ru
       ON  ru.id = c.reviewer_id
LEFT JOIN  public.claim_sla_rules sla
       ON  sla.institution_id = c.institution_id
      AND  sla.claim_type     = c.claim_type

ORDER BY c.created_at;


-- ── 2. POPULATION CHECK — run alongside, and compare ───────────────────────
-- If this count exceeds the number of rows section 1 returned, the export was
-- filtered by RLS and must be declared 'rls-limited'.

SELECT count(*) AS total_claims FROM public.verification_claims;


-- ── 3. DOES audit_logs CARRY CLAIM TRANSITIONS? ────────────────────────────
-- Run this before considering the richer source. It answers three questions at
-- once: whether claim rows are logged at all, what `action` values exist, and
-- whether the status is recoverable from new_value.
--
--   * No rows            -> transitions are not logged; stay with the derived
--                           history and keep its limitation documented.
--   * Rows, status in
--     new_value          -> switch to audit_logs; `reopened` and
--                           `post-terminal-change` become reachable, which the
--                           derived history cannot detect at all.
--   * Rows, but no status -> the log records that something changed without
--                           recording what. Worth fixing at the source.

SELECT
  a.action,
  count(*)                          AS occurrences,
  min(a.created_at)                 AS first_seen,
  max(a.created_at)                 AS last_seen,
  count(a.actor_user_id)            AS with_actor,
  count(a.new_value ->> 'status')   AS with_status_in_new_value
FROM   public.audit_logs a
WHERE  a.resource_type ILIKE '%claim%'
GROUP  BY a.action
ORDER  BY occurrences DESC;


-- ── 4. THE DERIVED HISTORY'S BLIND SPOT, MEASURED ──────────────────────────
-- A derived history is a LOWER BOUND: columns hold only the latest value, so a
-- claim reviewed, reopened and reviewed again presents as a single review.
-- This counts how many claims that could apply to, so the limitation can be
-- reported with a number rather than as a general caveat.
--
-- A claim whose updated_at is meaningfully later than its reviewed_at was
-- touched after its decision — the shape a reopen leaves behind.

SELECT count(*) AS claims_touched_after_decision
FROM   public.verification_claims
WHERE  reviewed_at IS NOT NULL
  AND  updated_at  IS NOT NULL
  AND  updated_at  > reviewed_at + interval '1 second';
