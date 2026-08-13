// episteme-core/src/evals/workflow-replay.ts
/**
 * Replays recorded verification-claim histories against the lifecycle rules.
 *
 * This is §3.18 dimension 5, previously covered only by two unit tests on the
 * Mastra workflow's handoff gates.
 *
 * ── WHICH LIFECYCLE THIS MODELS, AND WHY ─────────────────────────────────────
 * There are two descriptions of claim handling in this system and only one of
 * them is auditable.
 *
 *   verification-workflow.ts models the process as Mastra steps — validateClaim,
 *   routeClaim, awaitAdminAssignment, awaitHodDecision, recordOutcome. Mastra
 *   persists workflow runs to its RUNTIME store, which .env.example documents as
 *   deliberately local: "Traces are per-instance in production as a result."
 *   Nothing durable records those step names, so a replay built on them would
 *   examine zero rows forever while reporting green.
 *
 *   The DURABLE record is Supabase: verification_claims.status moving through
 *   the claim_status enum, with audit_logs capturing actor and timestamp for
 *   each change. That is what an auditor can read months later, and therefore
 *   what an integrity check has to be written against.
 *
 * This module models the second. The first version of it modelled the first,
 * which was a mistake — it encoded the design rather than the evidence.
 *
 * ── WHAT A REPLAY CATCHES THAT A UNIT TEST CANNOT ────────────────────────────
 * verification-workflow.test.ts asserts the gates reject a malformed resume
 * payload. That is a property of the code as written. It says nothing about the
 * claims that actually happened — whether one was ever approved without passing
 * through review, sat unassigned for three weeks, or reached a decision with no
 * recorded reviewer. Only the record answers those, and they are the questions
 * an audit asks.
 *
 * Pure: the runner supplies the history, this module decides nothing about
 * where it comes from.
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
 * The load-bearing entry is `pending`: it may NOT go straight to approved or
 * rejected. A claim that reaches a decision without entering review is one
 * approved without the review step the whole workflow exists to enforce, and
 * unlike the Mastra step graph this is checkable against production rows.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<string, readonly ClaimStatus[]>> = {
  [STATUS.pending]:   [STATUS.inReview, STATUS.cancelled],
  [STATUS.inReview]:  [STATUS.approved, STATUS.rejected, STATUS.cancelled],
  [STATUS.approved]:  [],
  [STATUS.rejected]:  [],
  [STATUS.cancelled]: [],
};

/** Statuses that end a claim's life. */
export const TERMINAL_STATUSES: readonly ClaimStatus[] = [
  STATUS.approved, STATUS.rejected, STATUS.cancelled,
];

/**
 * Statuses representing a STAFF DECISION, which must name who made it.
 *
 * `cancelled` is excluded deliberately: a claimant withdrawing their own request
 * is not a decision anyone else is accountable for, and requiring a reviewer
 * there would report every ordinary withdrawal as an audit failure.
 */
export const DECISION_STATUSES: readonly ClaimStatus[] = [STATUS.approved, STATUS.rejected];

/** Statuses a claim waits in, and which therefore have an SLA. */
export const WAITING_STATUSES: readonly ClaimStatus[] = [STATUS.pending, STATUS.inReview];

/**
 * One recorded status change, as reconstructed from audit_logs joined to
 * verification_claims.
 */
export interface TransitionRecord {
  claimId: string;
  /** The status the claim moved INTO. */
  status: string;
  /** ISO timestamp of the change (audit_logs.created_at). */
  at: string;
  /** audit_logs.actor_user_id. Required on a staff decision. */
  actor?: string | null;
}

export type FindingKind =
  | 'illegal-transition'
  | 'wrong-entry-point'
  | 'missing-actor'
  | 'post-terminal-change'
  | 'incomplete'
  | 'time-travel'
  | 'sla-breach';

export interface ReplayFinding {
  claimId: string;
  kind: FindingKind;
  detail: string;
}

export interface ReplayOptions {
  /** Hours a claim may wait in one status before it is an SLA breach. */
  slaHours?: number;
  /**
   * Treat a claim still open at export time as a defect. Off by default: a
   * claim legitimately under review is not a failure, and flagging it would
   * make every export noisy.
   */
  requireTerminal?: boolean;
}

const DEFAULT_SLA_HOURS = 72;

/**
 * Replays one claim's history.
 *
 * Returns every finding rather than stopping at the first: a claim that skipped
 * review AND lost its reviewer has two problems, and reporting one would hide
 * the other from whoever has to fix it.
 */
export function replayClaim(
  history: readonly TransitionRecord[],
  options: ReplayOptions = {},
): ReplayFinding[] {
  const slaHours = options.slaHours ?? DEFAULT_SLA_HOURS;
  const findings: ReplayFinding[] = [];
  if (history.length === 0) return findings;

  const claimId = history[0]!.claimId;
  const add = (kind: FindingKind, detail: string) => findings.push({ claimId, kind, detail });

  // Order by recorded time. Storage order is not guaranteed, and sorting here
  // means an unordered export is not misreported as an illegal transition.
  const ordered = [...history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

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

    // A staff decision must name who made it. An approval nobody is
    // accountable for is not an approval.
    if (DECISION_STATUSES.includes(current.status as ClaimStatus) && !current.actor) {
      add('missing-actor', `moved to "${current.status}" with no recorded actor`);
    }

    if (!next) break;

    if (TERMINAL_STATUSES.includes(current.status as ClaimStatus)) {
      add('post-terminal-change',
        `"${current.status}" is terminal but the claim later moved to "${next.status}"`);
      continue;
    }

    const legal = LEGAL_TRANSITIONS[current.status]!;
    if (!legal.includes(next.status as ClaimStatus)) {
      add('illegal-transition',
        `"${current.status}" -> "${next.status}"; only ${legal.join(', ')} permitted`);
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

    // SLA applies to the statuses a claim WAITS in. A terminal status has no
    // duration, and timing it would measure how long ago the claim finished.
    if (WAITING_STATUSES.includes(current.status as ClaimStatus)) {
      const heldHours = (to - from) / 3_600_000;
      if (heldHours > slaHours) {
        add('sla-breach',
          `held in "${current.status}" for ${heldHours.toFixed(1)}h, over the ${slaHours}h threshold`);
      }
    }
  }

  const last = ordered[ordered.length - 1]!;
  if (options.requireTerminal && !TERMINAL_STATUSES.includes(last.status as ClaimStatus)) {
    add('incomplete', `claim is still "${last.status}" and never reached a terminal status`);
  }

  return findings;
}

export interface ReplaySummary {
  claimsReplayed: number;
  claimsClean: number;
  findings: ReplayFinding[];
  byKind: Record<string, number>;
  /** Claims that reached a terminal status. */
  completed: number;
  /** Terminal status counts, for the outcome distribution. */
  outcomes: Record<string, number>;
}

/** Replays many claims, grouping transitions by claimId. */
export function replayAll(
  history: readonly TransitionRecord[],
  options: ReplayOptions = {},
): ReplaySummary {
  const byClaim = new Map<string, TransitionRecord[]>();
  for (const t of history) {
    const list = byClaim.get(t.claimId) ?? [];
    list.push(t);
    byClaim.set(t.claimId, list);
  }

  const findings: ReplayFinding[] = [];
  const outcomes: Record<string, number> = {};
  let claimsClean = 0;
  let completed = 0;

  for (const [, list] of byClaim) {
    const claimFindings = replayClaim(list, options);
    if (claimFindings.length === 0) claimsClean++;
    findings.push(...claimFindings);

    const terminal = list.find((t) => TERMINAL_STATUSES.includes(t.status as ClaimStatus));
    if (terminal) {
      completed++;
      outcomes[terminal.status] = (outcomes[terminal.status] ?? 0) + 1;
    }
  }

  const byKind: Record<string, number> = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;

  return { claimsReplayed: byClaim.size, claimsClean, findings, byKind, completed, outcomes };
}

/** Multi-line report for the eval output. */
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

  if (s.findings.length === 0) {
    lines.push('', '  Every claim followed a legal status sequence with a complete audit trail.');
    return lines.join('\n');
  }

  lines.push('', '  findings by kind:');
  for (const [kind, count] of Object.entries(s.byKind).sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${kind.padEnd(22)} ${count}`);
  }
  lines.push('', '  detail:');
  for (const f of s.findings.slice(0, 20)) {
    lines.push(`    [${f.kind}] claim ${f.claimId}: ${f.detail}`);
  }
  if (s.findings.length > 20) lines.push(`    ... and ${s.findings.length - 20} more`);

  return lines.join('\n');
}
