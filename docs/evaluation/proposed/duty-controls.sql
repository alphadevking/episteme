-- ============================================================================
--  PROPOSED — separation-of-duties controls for verification_claims
--
--  DRAFT. NOT APPLIED. Written against lib/types/database.ts (generated types),
--  not against a live database. Review every statement before running any of it,
--  and run STEP 0 first: the constraints below cannot be validated while a
--  violating row exists, and finding out by way of a failed migration on
--  production is the wrong way to learn you have one.
--
--  ── WHY THIS EXISTS ────────────────────────────────────────────────────────
--  src/evals/workflow-replay.ts detects self-approval, dual-control breaches and
--  cross-institution decisions AFTER they happen. That supports the claim "no
--  violations observed across N claims". It does NOT support "self-approval is
--  prevented" — only an enforced constraint supports that, and none exists.
--
--  Detective controls are the weaker half of the pair. A harness that finds a
--  self-approved transcript request next week is a worse outcome than a CHECK
--  constraint that made the row impossible to write. This closes that gap.
--
--  ── ROLLOUT SHAPE ──────────────────────────────────────────────────────────
--  Each constraint is added NOT VALID, then validated separately. NOT VALID
--  enforces the rule on every new and updated row immediately while leaving
--  existing rows unexamined, so the migration cannot fail on legacy data and
--  cannot lock the table for long. VALIDATE then checks history, and is the
--  statement that may fail — which is exactly when you want to know.
-- ============================================================================


-- ── STEP 0 — DETECTION. Run this first, on its own. ─────────────────────────
-- If any of these return rows, STOP. Those rows are the finding, and they need
-- a decision (correct them? annotate them?) before any constraint is validated.

-- 0a. Self-review: a claim decided by its own subject.
SELECT id, user_id, reviewer_id, status, reviewed_at
FROM   public.verification_claims
WHERE  reviewer_id IS NOT NULL
  AND  reviewer_id = user_id;

-- 0b. Dual control: the same person routed and decided the claim.
--     auto_routed claims are exempt — the system assigned them, so there is no
--     second human to be distinct from.
SELECT id, assigned_by, reviewer_id, auto_routed, status
FROM   public.verification_claims
WHERE  reviewer_id IS NOT NULL
  AND  assigned_by IS NOT NULL
  AND  auto_routed IS NOT TRUE
  AND  assigned_by = reviewer_id;

-- 0c. Authority scope: the reviewer belongs to a different institution.
SELECT c.id, c.institution_id AS claim_institution,
       u.institution_id       AS reviewer_institution,
       c.reviewer_id, c.status
FROM   public.verification_claims c
JOIN   public.users u ON u.id = c.reviewer_id
WHERE  c.reviewer_id IS NOT NULL
  AND  u.institution_id IS DISTINCT FROM c.institution_id;


-- ── STEP 1 — PREVENTIVE CONSTRAINTS, added NOT VALID ───────────────────────
-- Safe to run even with violating history: these bind new and updated rows only
-- until STEP 2 validates them.

-- 1a. No self-review. The single most serious failure this workflow can have.
ALTER TABLE public.verification_claims
  ADD CONSTRAINT chk_claim_no_self_review
  CHECK (reviewer_id IS NULL OR reviewer_id <> user_id)
  NOT VALID;

-- 1b. Dual control, exempting auto-routed claims.
ALTER TABLE public.verification_claims
  ADD CONSTRAINT chk_claim_dual_control
  CHECK (
    reviewer_id  IS NULL
    OR assigned_by IS NULL
    OR auto_routed IS TRUE
    OR assigned_by <> reviewer_id
  )
  NOT VALID;

-- NOTE ON 1c. Authority scope is NOT a CHECK constraint. A CHECK may only read
-- the row it guards, and this rule needs users.institution_id — so it has to be
-- a trigger (STEP 3) or live in the transition RPC. Attempting it as a CHECK
-- with a subquery will be rejected by Postgres.


-- ── STEP 2 — VALIDATE, only after STEP 0 came back empty ───────────────────
-- These read every existing row. Each may fail; a failure means history
-- contains a violation and STEP 0 was skipped or its output ignored.

ALTER TABLE public.verification_claims VALIDATE CONSTRAINT chk_claim_no_self_review;
ALTER TABLE public.verification_claims VALIDATE CONSTRAINT chk_claim_dual_control;


-- ── STEP 3 — AUTHORITY SCOPE, as a trigger ─────────────────────────────────
-- Fires only when reviewer_id is being set or changed, so ordinary updates to
-- unrelated columns pay nothing.

CREATE OR REPLACE FUNCTION public.fn_enforce_reviewer_authority()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY INVOKER deliberately: this must read users under the caller's own
-- rights. A DEFINER function here would read rows the caller cannot see, which
-- is how an authorization check turns into an information leak.
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  reviewer_institution uuid;
BEGIN
  IF NEW.reviewer_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT u.institution_id INTO reviewer_institution
  FROM   public.users u
  WHERE  u.id = NEW.reviewer_id;

  -- An unresolvable reviewer is REJECTED, not waved through. Treating "cannot
  -- determine" as "permitted" is the failure mode this whole exercise has been
  -- unpicking: an unverifiable check that reports success.
  IF reviewer_institution IS NULL THEN
    RAISE EXCEPTION
      'reviewer % has no institution; cannot verify authority over claim %',
      NEW.reviewer_id, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF reviewer_institution IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION
      'reviewer % belongs to institution %, claim % belongs to %',
      NEW.reviewer_id, reviewer_institution, NEW.id, NEW.institution_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_reviewer_authority ON public.verification_claims;

CREATE TRIGGER trg_enforce_reviewer_authority
  BEFORE INSERT OR UPDATE OF reviewer_id, institution_id
  ON public.verification_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_enforce_reviewer_authority();


-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- ALTER TABLE public.verification_claims DROP CONSTRAINT IF EXISTS chk_claim_no_self_review;
-- ALTER TABLE public.verification_claims DROP CONSTRAINT IF EXISTS chk_claim_dual_control;
-- DROP TRIGGER IF EXISTS trg_enforce_reviewer_authority ON public.verification_claims;
-- DROP FUNCTION IF EXISTS public.fn_enforce_reviewer_authority();


-- ── WHAT THIS DOES NOT COVER ───────────────────────────────────────────────
--  * A service-role client bypasses RLS but NOT these constraints, which is the
--    point: they bind every writer including migrations and admin tooling.
--  * The status transition graph (pending -> in_review -> decision) is still
--    unenforced here. It belongs in the transition RPC rather than a CHECK,
--    because a CHECK cannot see the row's previous value. workflow-replay.ts
--    detects violations of it in the meantime.
--  * Department-level authority for academic claims is not enforced; only
--    institution. Adding it needs a decision about which claim types require
--    departmental scope.
