// episteme-core/src/evals/workflow-replay.ts
/**
 * Replays recorded verification claims against the lifecycle rules AND the
 * separation-of-duties controls that make an approval mean anything.
 *
 * This is §3.18 dimension 5.
 *
 * ── WHICH LIFECYCLE THIS MODELS ──────────────────────────────────────────────
 * Two descriptions of claim handling exist in this system and only one is
 * auditable. verification-workflow.ts models it as Mastra steps, but Mastra
 * persists runs to its RUNTIME store, which .env.example documents as
 * deliberately local — "traces are per-instance in production as a result".
 * Nothing durable records those step names, so a replay built on them would
 * examine zero rows forever while reporting green.
 *
 * The durable record is Supabase: verification_claims.status moving through the
 * claim_status enum, with audit_logs supplying actor and timestamp. That is what
 * an auditor can read months later, so that is what this checks.
 *
 * ── CASE ATTRIBUTES vs EVENT ATTRIBUTES ──────────────────────────────────────
 * Claimant, reviewer, institution and department are properties of the CLAIM.
 * Status, timestamp and actor are properties of a TRANSITION. Process mining
 * keeps these separate — it is the distinction the XES event-log standard
 * encodes — and flattening claim fields onto every event row would be a
 * modelling error that the exporter then has to carry forever.
 *
 * ── DETECTIVE, NOT PREVENTIVE ────────────────────────────────────────────────
 * Everything here finds a violation AFTER it happened. That is strictly weaker
 * than a database constraint refusing to write it, and the distinction matters
 * for what may be claimed: a clean run here supports "no violations observed
 * across N claims". It does NOT support "self-approval is prevented". Only an
 * enforced constraint supports the second, and none exists yet.
 *
 * ── INDEPENDENCE ─────────────────────────────────────────────────────────────
 * Every control below compares STORED FACTS — reviewer_id against user_id as
 * recorded. None calls a helper the write path also calls. A check that re-runs
 * the logic it is auditing is a tautology, not verification; retrieval-gate's
 * expandAudienceRoles is already flagged elsewhere in this repo for exactly that
 * weakness.
 */

/** The claim_status enum, mirrored from the Supabase schema. */
export const STATUS = {
  pending: 'pending',
  inReview: 'in_review',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
} as const;

export type ClaimStatus = (typeof STATUS)[keyof typeof STATUS];

/**
 * Legal successors of each status.
 *
 * The load-bearing entry is `pending`: it may NOT reach a decision directly. A
 * claim approved without entering review is one decided without the step the
 * whole workflow exists to enforce.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<string, readonly ClaimStatus[]>> = {
  [STATUS.pending]:   [STATUS.inReview, STATUS.cancelled],
  [STATUS.inReview]:  [STATUS.approved, STATUS.rejected, STATUS.cancelled],
  [STATUS.approved]:  [],
  [STATUS.rejected]:  [],
  [STATUS.cancelled]: [],
};

export const TERMINAL_STATUSES: readonly ClaimStatus[] = [
  STATUS.approved, STATUS.rejected, STATUS.cancelled,
];

/**
 * Statuses representing a STAFF DECISION, which must name who made it.
 * `cancelled` is excluded: a claimant withdrawing their own request is not a
 * decision anyone else is accountable for.
 */
export const DECISION_STATUSES: readonly ClaimStatus[] = [STATUS.approved, STATUS.rejected];

/** Statuses a claim waits in, and which therefore have an SLA. */
export const WAITING_STATUSES: readonly ClaimStatus[] = [STATUS.pending, STATUS.inReview];

// ── Records ───────────────────────────────────────────────────────────────────

/** CASE attributes — properties of the claim itself. */
export interface ClaimRecord {
  claimId: string;
  /** The claimant (verification_claims.user_id). */
  userId: string;
  claimType: string;
  institutionId: string;
  departmentId?: string | null;
  /** Who routed it. Null when the system did (auto_routed). */
  assignedBy?: string | null;
  assignedTo?: string | null;
  /** Who decided it (verification_claims.reviewer_id). */
  reviewerId?: string | null;
  /** True when the system routed it with no human assigner. */
  autoRouted?: boolean;
  /**
   * The reviewer's own institution, resolved by the exporter from users.institution_id.
   * Undefined means "not resolved" and the scope check is SKIPPED rather than
   * assumed to pass — an unresolved join must never read as compliance.
   */
  reviewerInstitutionId?: string | null;
  /**
   * This claim's SLA in hours, resolved by the exporter from claim_sla_rules
   * (hod_sla_hours, keyed by claim_type + institution_id).
   *
   * The system already defines its own SLA per claim type per institution.
   * Measuring against a constant invented here would report breaches of a
   * threshold nobody agreed to, and miss breaches of the one they did.
   * options.slaHours is only the fallback when no rule exists for a claim.
   */
  slaHours?: number | null;
}

/** EVENT attributes — one recorded status change. */
export interface TransitionRecord {
  claimId: string;
  /** The status the claim moved INTO. */
  status: string;
  /** ISO timestamp of the change (audit_logs.created_at). */
  at: string;
  /** audit_logs.actor_user_id. Required on a staff decision. */
  actor?: string | null;
}

/** One claim and its history, as the exporter should return it. */
export interface ClaimHistory {
  claim: ClaimRecord;
  transitions: TransitionRecord[];
}

// ── Findings ──────────────────────────────────────────────────────────────────

export type FindingKind =
  | 'self-review'
  | 'authority-scope'
  | 'dual-control'
  | 'approval-without-review'
  | 'illegal-transition'
  | 'wrong-entry-point'
  | 'missing-actor'
  | 'post-terminal-change'
  | 'reopened'
  | 'incomplete'
  | 'time-travel'
  | 'sla-breach';

/**
 * critical — a claim may have been wrongly granted.
 * high     — a control or audit-trail failure; the decision may still be sound.
 * advisory — data quality or timeliness.
 *
 * Ranked because an audit report that lists a self-approval next to a 73-hour
 * SLA breach, undifferentiated, buries the one that matters.
 */
export type Severity = 'critical' | 'high' | 'advisory';

export const SEVERITY_OF: Readonly<Record<FindingKind, Severity>> = {
  'self-review':             'critical',
  'authority-scope':         'critical',
  'approval-without-review': 'critical',
  'dual-control':            'high',
  'illegal-transition':      'high',
  'missing-actor':           'high',
  'post-terminal-change':    'high',
  'reopened':                'advisory',
  'wrong-entry-point':       'advisory',
  'incomplete':              'advisory',
  'time-travel':             'advisory',
  'sla-breach':              'advisory',
};

export interface ReplayFinding {
  claimId: string;
  kind: FindingKind;
  severity: Severity;
  detail: string;
}

export interface ReplayOptions {
  /** Fallback SLA for claims with no rule in claim_sla_rules. */
  slaHours?: number;
  /** Treat a claim still open at export time as a defect. Off by default. */
  requireTerminal?: boolean;
}

const DEFAULT_SLA_HOURS = 72;

// ── Replay ────────────────────────────────────────────────────────────────────

/**
 * Replays one claim: its status history, then the duty controls.
 *
 * Returns every finding rather than stopping at the first — a claim that skipped
 * review AND was self-approved has two problems, and reporting one would hide
 * the other from whoever has to fix it.
 */
export function replayClaim(
  history: ClaimHistory,
  options: ReplayOptions = {},
): ReplayFinding[] {
  const { claim, transitions } = history;
  // The claim's own rule wins; the option is only a fallback for claims with no
  // configured rule.
  const slaHours = claim.slaHours ?? options.slaHours ?? DEFAULT_SLA_HOURS;
  const findings: ReplayFinding[] = [];
  const add = (kind: FindingKind, detail: string) =>
    findings.push({ claimId: claim.claimId, kind, severity: SEVERITY_OF[kind], detail });

  // ── Duty controls. These read stored identity fields and are checkable even
  // when no transition history survives, which is the point: a claim row alone
  // is enough to show it was self-approved.
  const decided = claim.reviewerId != null && claim.reviewerId !== '';

  if (decided && claim.reviewerId === claim.userId) {
    add('self-review',
      `reviewer ${claim.reviewerId} is the claimant — the claim was approved by its own subject`);
  }

  // Four-eyes. Exempt auto-routed claims: the system assigned them, so there is
  // no second human to be distinct from, and flagging them would report every
  // routed claim as a control failure.
  if (decided && !claim.autoRouted && claim.assignedBy && claim.assignedBy === claim.reviewerId) {
    add('dual-control',
      `${claim.reviewerId} both routed and decided the claim; dual control requires two people`);
  }

  // Authority scope. SKIPPED, not passed, when the reviewer's institution was
  // not resolved — an unresolved join must never read as compliance.
  if (decided && claim.reviewerInstitutionId != null
      && claim.reviewerInstitutionId !== claim.institutionId) {
    add('authority-scope',
      `reviewer belongs to institution ${claim.reviewerInstitutionId}, ` +
      `the claim to ${claim.institutionId}`);
  }

  if (transitions.length === 0) return findings;

  // Order by recorded time. Storage order is not guaranteed, and sorting here
  // means an unordered export is not misreported as an illegal transition.
  const ordered = [...transitions].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  if (ordered[0]!.status !== STATUS.pending) {
    add('wrong-entry-point',
      `history begins at "${ordered[0]!.status}"; every claim is created as "${STATUS.pending}"`);
  }

  for (let i = 0; i < ordered.length; i++) {
    const current = ordered[i]!;
    const next = ordered[i + 1];

    if (!(current.status in LEGAL_TRANSITIONS)) {
      add('illegal-transition', `unknown status "${current.status}"`);
      continue;
    }

    if (DECISION_STATUSES.includes(current.status as ClaimStatus) && !current.actor) {
      add('missing-actor', `moved to "${current.status}" with no recorded actor`);
    }

    if (!next) break;

    if (TERMINAL_STATUSES.includes(current.status as ClaimStatus)) {
      // A decided claim returning to review is what fn_admin_reopen_claim does,
      // and it is a SUPPORTED operation — reporting it as a control failure
      // would flag every legitimate reopen. Recorded as advisory so it stays
      // visible in the audit trail without being read as a violation. Any OTHER
      // move out of a terminal status has no supported path and stays high.
      if (next.status === STATUS.inReview) {
        add('reopened', `"${current.status}" was reopened to "${STATUS.inReview}"`);
      } else {
        add('post-terminal-change',
          `"${current.status}" is terminal but the claim later moved to "${next.status}"`);
      }
      continue;
    }

    const legal = LEGAL_TRANSITIONS[current.status]!;
    if (!legal.includes(next.status as ClaimStatus)) {
      // Reaching a decision straight from pending is not merely a process
      // deviation — it means the review never happened. Separated from ordinary
      // illegal transitions so it ranks critical rather than high.
      if (current.status === STATUS.pending
          && DECISION_STATUSES.includes(next.status as ClaimStatus)) {
        add('approval-without-review',
          `"pending" -> "${next.status}"; the claim never entered "${STATUS.inReview}"`);
      } else {
        add('illegal-transition',
          `"${current.status}" -> "${next.status}"; only ${legal.join(', ')} permitted`);
      }
    }

    const from = Date.parse(current.at);
    const to = Date.parse(next.at);
    if (Number.isNaN(from) || Number.isNaN(to)) {
      add('time-travel', `unparseable timestamp around "${current.status}"`);
      continue;
    }
    if (to < from) {
      add('time-travel', `"${next.status}" recorded before "${current.status}"`);
      continue;
    }

    if (WAITING_STATUSES.includes(current.status as ClaimStatus)) {
      const heldHours = (to - from) / 3_600_000;
      if (heldHours > slaHours) {
        const source = claim.slaHours != null ? 'configured' : 'fallback';
        add('sla-breach',
          `held in "${current.status}" for ${heldHours.toFixed(1)}h, ` +
          `over the ${slaHours}h ${source} threshold`);
      }
    }
  }

  const last = ordered[ordered.length - 1]!;
  if (options.requireTerminal && !TERMINAL_STATUSES.includes(last.status as ClaimStatus)) {
    add('incomplete', `claim is still "${last.status}" and never reached a terminal status`);
  }

  return findings;
}

/**
 * What the exporter actually read.
 *
 * `rls-limited` means the query ran under row-level security and saw only rows
 * the caller was permitted to see. A control result over a partial population is
 * not evidence, and this repo has already produced two such results by not
 * asking the question.
 */
export type PopulationScope = 'full' | 'rls-limited' | 'unknown';

export interface ReplaySummary {
  claimsReplayed: number;
  claimsClean: number;
  findings: ReplayFinding[];
  byKind: Record<string, number>;
  bySeverity: Record<Severity, number>;
  completed: number;
  outcomes: Record<string, number>;
  scope: PopulationScope;
  /** Claims whose reviewer institution could not be resolved — scope unchecked. */
  authorityScopeUnresolved: number;
}

export function replayAll(
  histories: readonly ClaimHistory[],
  options: ReplayOptions = {},
  scope: PopulationScope = 'unknown',
): ReplaySummary {
  const findings: ReplayFinding[] = [];
  const outcomes: Record<string, number> = {};
  let claimsClean = 0;
  let completed = 0;
  let authorityScopeUnresolved = 0;

  for (const history of histories) {
    const claimFindings = replayClaim(history, options);
    if (claimFindings.length === 0) claimsClean++;
    findings.push(...claimFindings);

    const terminal = history.transitions.find(
      (t) => TERMINAL_STATUSES.includes(t.status as ClaimStatus),
    );
    if (terminal) {
      completed++;
      outcomes[terminal.status] = (outcomes[terminal.status] ?? 0) + 1;
    }

    const decided = history.claim.reviewerId != null && history.claim.reviewerId !== '';
    if (decided && history.claim.reviewerInstitutionId == null) authorityScopeUnresolved++;
  }

  const byKind: Record<string, number> = {};
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, advisory: 0 };
  for (const f of findings) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    bySeverity[f.severity]++;
  }

  return {
    claimsReplayed: histories.length,
    claimsClean, findings, byKind, bySeverity, completed, outcomes,
    scope, authorityScopeUnresolved,
  };
}

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'advisory'];

/** Multi-line report for the eval output, most severe first. */
export function formatReplay(s: ReplaySummary): string {
  if (s.claimsReplayed === 0) {
    return '  No recorded claims to replay — workflow integrity is UNVERIFIED.\n' +
           '  This is NOT a pass. Submit and resolve at least one claim before citing\n' +
           '  this dimension; a check that examined nothing proves nothing.';
  }

  const lines = [
    `  claims replayed  ${s.claimsReplayed}`,
    `  reached outcome  ${s.completed}`,
    `  clean            ${s.claimsClean}/${s.claimsReplayed}`,
  ];

  const outcomeList = Object.entries(s.outcomes).sort((a, b) => b[1] - a[1]);
  if (outcomeList.length > 0) {
    lines.push(`  outcomes         ${outcomeList.map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }

  // Population first: everything below is read against it.
  if (s.scope !== 'full') {
    lines.push(
      '',
      `  WARNING  population scope is "${s.scope}". A control result over rows the`,
      '           query was permitted to see is not evidence. Export with a service-role',
      '           client that bypasses RLS before citing any figure here.',
    );
  }

  if (s.authorityScopeUnresolved > 0) {
    lines.push(
      '',
      `  NOTE  ${s.authorityScopeUnresolved} decided claim(s) had no resolvable reviewer institution,`,
      '        so the authority-scope control was SKIPPED for them — not passed.',
    );
  }

  if (s.findings.length === 0) {
    lines.push('', '  No control failures. Every claim followed a legal status sequence with a',
                   '  complete audit trail, and no decision was made by its own subject.');
    return lines.join('\n');
  }

  lines.push('', '  findings by severity:');
  for (const sev of SEVERITY_ORDER) {
    if (s.bySeverity[sev] > 0) lines.push(`    ${sev.padEnd(10)} ${s.bySeverity[sev]}`);
  }

  lines.push('', '  detail (most severe first):');
  const ranked = [...s.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  for (const f of ranked.slice(0, 25)) {
    lines.push(`    [${f.severity}/${f.kind}] claim ${f.claimId}: ${f.detail}`);
  }
  if (ranked.length > 25) lines.push(`    ... and ${ranked.length - 25} more`);

  return lines.join('\n');
}
