// episteme-core/src/evals/claim-history.ts
/**
 * Turns a verification_claims row into the ClaimHistory that workflow-replay
 * consumes.
 *
 * ── WHY THIS DERIVES FROM COLUMNS AND NOT FROM audit_logs ────────────────────
 * The obvious source for a status history is audit_logs, and it would be the
 * richer one — an actor and a timestamp per change, including repeats.
 *
 * It is not used here because it CANNOT BE RELIED ON YET. The only audit writes
 * visible in the application are `fn_write_audit_log_for_kb`, for knowledge-base
 * actions. The claim RPCs (fn_admin_assign_claim, fn_hod_review_claim,
 * fn_admin_reopen_claim) are SECURITY DEFINER and may well write audit rows
 * internally, but neither the `action` vocabulary nor whether `new_value`
 * carries the status can be established from outside the database. Building the
 * export on an assumed shape would produce an empty or wrong history that reads
 * as a clean audit — the precise failure this whole harness exists to refuse.
 *
 * verification_claims' own timestamps are certain. created_at, assigned_at and
 * reviewed_at exist on every row, and assigned_by / reviewer_id attribute the
 * transitions they mark. That is enough for a complete, actor-attributed
 * history of the ordinary path.
 *
 * ── THE LIMITATION, STATED PLAINLY ───────────────────────────────────────────
 * Columns hold only the LATEST value. A claim reviewed, reopened and reviewed
 * again presents as a single review — the reopen is invisible, and so is any
 * earlier decision. A derived history is therefore a LOWER BOUND on what
 * happened: it can prove a violation occurred, never that none did.
 *
 * Concretely, `reopened` and `post-terminal-change` findings are UNREACHABLE
 * from a derived history. They are reachable from audit_logs, which is the
 * argument for moving to it once its shape is confirmed.
 */
import type { ClaimHistory, ClaimRecord, TransitionRecord } from './workflow-replay';
import { STATUS, TERMINAL_STATUSES, type ClaimStatus } from './workflow-replay';

/**
 * The verification_claims columns this reads, named as the database names them
 * so the exporter's SELECT maps across without a translation layer to get wrong.
 */
export interface ClaimRow {
  id: string;
  user_id: string;
  claim_type: string;
  institution_id: string;
  department_id?: string | null;
  assigned_by?: string | null;
  assigned_to?: string | null;
  reviewer_id?: string | null;
  auto_routed?: boolean | null;
  status: string;
  created_at: string;
  assigned_at?: string | null;
  reviewed_at?: string | null;
  updated_at?: string | null;
}

/** Values the exporter resolves by joining other tables. */
export interface ClaimEnrichment {
  /** users.institution_id for reviewer_id. Omit when the join found nothing. */
  reviewerInstitutionId?: string | null;
  /** claim_sla_rules.hod_sla_hours for this claim_type + institution. */
  slaHours?: number | null;
}

/**
 * Derives one claim's history.
 *
 * Emits only transitions the row actually evidences. A claim whose status is
 * `approved` with no `assigned_at` yields `pending -> approved`, which is
 * exactly right: the row carries no evidence it was ever reviewed, and
 * workflow-replay will report approval-without-review. Inventing an in_review
 * step to make the sequence look legal would erase the finding.
 */
export function claimHistoryFromRow(
  row: ClaimRow,
  enrichment: ClaimEnrichment = {},
): ClaimHistory {
  const claim: ClaimRecord = {
    claimId: row.id,
    userId: row.user_id,
    claimType: row.claim_type,
    institutionId: row.institution_id,
    departmentId: row.department_id ?? null,
    assignedBy: row.assigned_by ?? null,
    assignedTo: row.assigned_to ?? null,
    reviewerId: row.reviewer_id ?? null,
    autoRouted: row.auto_routed === true,
    reviewerInstitutionId: enrichment.reviewerInstitutionId ?? null,
    slaHours: enrichment.slaHours ?? null,
  };

  const transitions: TransitionRecord[] = [];
  const push = (status: string, at: string, actor?: string | null) =>
    transitions.push({ claimId: row.id, status, at, actor: actor ?? null });

  // Every claim is created pending, by its claimant.
  push(STATUS.pending, row.created_at, row.user_id);

  // Assignment is what starts review. Attributed to whoever assigned it; an
  // auto-routed claim has no human assigner, so the actor is null and the
  // dual-control exemption in workflow-replay covers it.
  if (row.assigned_at) {
    push(STATUS.inReview, row.assigned_at, row.assigned_by ?? null);
  }

  // The current status, when terminal, is the outcome. Timed by reviewed_at
  // where present; a cancellation may not set it, so updated_at is the fallback
  // — and if neither exists the transition is emitted with an empty timestamp
  // rather than dropped, so replay reports it as unparseable instead of
  // silently showing a claim that never resolved.
  if (TERMINAL_STATUSES.includes(row.status as ClaimStatus)) {
    const at = row.reviewed_at ?? row.updated_at ?? '';
    const actor = row.status === STATUS.cancelled
      ? (row.reviewer_id ?? row.user_id)  // a cancellation is usually the claimant's
      : (row.reviewer_id ?? null);
    push(row.status, at, actor);
  }

  return { claim, transitions };
}

/** Maps a page of rows. Enrichment is looked up by claim id. */
export function claimHistoriesFromRows(
  rows: readonly ClaimRow[],
  enrichmentById: ReadonlyMap<string, ClaimEnrichment> = new Map(),
): ClaimHistory[] {
  return rows.map((row) => claimHistoryFromRow(row, enrichmentById.get(row.id) ?? {}));
}
