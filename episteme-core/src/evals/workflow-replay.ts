// episteme-core/src/evals/workflow-replay.ts
/**
 * Replays recorded verification-workflow runs against the transition rules.
 *
 * This is §3.18 dimension 5, previously covered only by two unit tests on the
 * handoff gates.
 *
 * ── WHAT A REPLAY CATCHES THAT A UNIT TEST CANNOT ────────────────────────────
 * verification-workflow.test.ts asserts that the gates REJECT a malformed
 * resume payload. That is a property of the code as written. It says nothing
 * about the runs that actually happened — whether a claim ever skipped the HOD
 * gate, sat suspended for three weeks, or reached an outcome with no recorded
 * reviewer.
 *
 * Those are the questions an audit asks, and they are answerable only from the
 * record. A verification workflow whose audit trail cannot be replayed is not
 * an auditable workflow, whatever its unit tests say.
 *
 * ── WHY EVERY CHECK HERE IS PURE ─────────────────────────────────────────────
 * The runner supplies transition records from storage; this module decides
 * nothing about where they come from. That keeps the rules testable against
 * fixtures covering shapes a live database may not have produced yet — a
 * skipped gate, a clock running backwards — which are exactly the shapes worth
 * being certain about before they appear in production.
 */

/**
 * Workflow step ids, mirroring verification-workflow.ts. A step renamed there
 * and not here shows up as an illegal transition on every run, which is the
 * correct failure: the replay rules would otherwise be silently checking a
 * workflow that no longer exists.
 */
export const STEPS = {
  validate: 'validateClaim',
  route: 'routeClaim',
  adminGate: 'awaitAdminAssignment',
  hodGate: 'awaitHodDecision',
  outcome: 'recordOutcome',
} as const;

/** The only legal successor of each step. */
export const LEGAL_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  [STEPS.validate]:  [STEPS.route],
  [STEPS.route]:     [STEPS.adminGate],
  [STEPS.adminGate]: [STEPS.hodGate],
  [STEPS.hodGate]:   [STEPS.outcome],
  [STEPS.outcome]:   [],
};

/** The two human handoff gates — the only steps permitted to suspend. */
export const SUSPENDABLE_STEPS: readonly string[] = [STEPS.adminGate, STEPS.hodGate];

export interface TransitionRecord {
  claimId: string;
  step: string;
  /** ISO timestamp this step was entered. */
  at: string;
  /** Who caused it. Required at a human gate; absent is legitimate elsewhere. */
  actor?: string | null;
  /** Whether the run suspended here awaiting a human. */
  suspended?: boolean;
}

export type FindingKind =
  | 'illegal-transition'
  | 'wrong-entry-point'
  | 'unexpected-suspend'
  | 'missing-actor'
  | 'incomplete'
  | 'time-travel'
  | 'sla-breach';

export interface ReplayFinding {
  claimId: string;
  kind: FindingKind;
  detail: string;
}

export interface ReplayOptions {
  /**
   * Hours a claim may sit at a human gate before it is an SLA breach.
   * Reported per gate, since the two have different realistic turnarounds.
   */
  slaHours?: number;
  /**
   * Treat a run that has not yet reached recordOutcome as incomplete. Off by
   * default: a claim legitimately in flight at the moment of export is not a
   * defect, and flagging it would make every export noisy.
   */
  requireTerminal?: boolean;
}

const DEFAULT_SLA_HOURS = 72;

/**
 * Replays one claim's transitions.
 *
 * Returns every finding rather than stopping at the first: a run that skipped a
 * gate AND lost its reviewer has two problems, and reporting one would hide the
 * other from whoever has to fix it.
 */
export function replayClaim(
  transitions: readonly TransitionRecord[],
  options: ReplayOptions = {},
): ReplayFinding[] {
  const slaHours = options.slaHours ?? DEFAULT_SLA_HOURS;
  const findings: ReplayFinding[] = [];
  if (transitions.length === 0) return findings;

  const claimId = transitions[0]!.claimId;
  const add = (kind: FindingKind, detail: string) => findings.push({ claimId, kind, detail });

  // Order by recorded time. Storage order is not guaranteed, and sorting here
  // means an out-of-order export is not misreported as an illegal transition.
  const ordered = [...transitions].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  if (ordered[0]!.step !== STEPS.validate) {
    add('wrong-entry-point',
      `run begins at ${ordered[0]!.step}; every claim must enter through ${STEPS.validate}`);
  }

  for (let i = 0; i < ordered.length; i++) {
    const current = ordered[i]!;
    const next = ordered[i + 1];

    if (!(current.step in LEGAL_TRANSITIONS)) {
      add('illegal-transition', `unknown step "${current.step}"`);
      continue;
    }

    // A step may only suspend if it is one of the two human gates.
    if (current.suspended && !SUSPENDABLE_STEPS.includes(current.step)) {
      add('unexpected-suspend',
        `${current.step} suspended, but only ${SUSPENDABLE_STEPS.join(' and ')} may`);
    }

    // A human gate that advanced must say who advanced it. This is the audit
    // property: an approval nobody is accountable for is not an approval.
    if (SUSPENDABLE_STEPS.includes(current.step) && next && !current.actor) {
      add('missing-actor', `${current.step} advanced with no recorded actor`);
    }

    if (!next) break;

    const legal = LEGAL_TRANSITIONS[current.step]!;
    if (!legal.includes(next.step)) {
      add('illegal-transition',
        `${current.step} -> ${next.step}; only ${legal.length > 0 ? legal.join(', ') : '(terminal)'} is permitted`);
    }

    const from = Date.parse(current.at);
    const to = Date.parse(next.at);
    if (Number.isNaN(from) || Number.isNaN(to)) {
      add('time-travel', `unparseable timestamp between ${current.step} and ${next.step}`);
      continue;
    }
    if (to < from) {
      add('time-travel', `${next.step} recorded before ${current.step}`);
      continue;
    }

    // SLA applies only at the human gates. Machine steps run in milliseconds,
    // so timing them would measure the provider, not the process.
    if (SUSPENDABLE_STEPS.includes(current.step)) {
      const heldHours = (to - from) / 3_600_000;
      if (heldHours > slaHours) {
        add('sla-breach',
          `${current.step} held ${heldHours.toFixed(1)}h, over the ${slaHours}h threshold`);
      }
    }
  }

  if (options.requireTerminal && ordered[ordered.length - 1]!.step !== STEPS.outcome) {
    add('incomplete', `run ends at ${ordered[ordered.length - 1]!.step}, never reaching ${STEPS.outcome}`);
  }

  return findings;
}

export interface ReplaySummary {
  claimsReplayed: number;
  claimsClean: number;
  findings: ReplayFinding[];
  byKind: Record<string, number>;
  /** Claims that reached recordOutcome. */
  completed: number;
}

/** Replays many claims, grouping transitions by claimId. */
export function replayAll(
  transitions: readonly TransitionRecord[],
  options: ReplayOptions = {},
): ReplaySummary {
  const byClaim = new Map<string, TransitionRecord[]>();
  for (const t of transitions) {
    const list = byClaim.get(t.claimId) ?? [];
    list.push(t);
    byClaim.set(t.claimId, list);
  }

  const findings: ReplayFinding[] = [];
  let claimsClean = 0;
  let completed = 0;

  for (const [, list] of byClaim) {
    const claimFindings = replayClaim(list, options);
    if (claimFindings.length === 0) claimsClean++;
    findings.push(...claimFindings);
    if (list.some((t) => t.step === STEPS.outcome)) completed++;
  }

  const byKind: Record<string, number> = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;

  return { claimsReplayed: byClaim.size, claimsClean, findings, byKind, completed };
}

/** Multi-line report for the eval output. */
export function formatReplay(s: ReplaySummary): string {
  if (s.claimsReplayed === 0) {
    return '  No recorded claims to replay — the workflow has not run, so integrity is UNVERIFIED.\n' +
           '  This is not a pass. Submit and resolve at least one claim before citing this dimension.';
  }

  const lines = [
    `  claims replayed  ${s.claimsReplayed}`,
    `  reached outcome  ${s.completed}`,
    `  clean            ${s.claimsClean}/${s.claimsReplayed}`,
  ];

  if (s.findings.length === 0) {
    lines.push('', '  Every run followed a legal transition sequence with a complete audit trail.');
    return lines.join('\n');
  }

  lines.push('', '  findings by kind:');
  for (const [kind, count] of Object.entries(s.byKind).sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${kind.padEnd(20)} ${count}`);
  }
  lines.push('', '  detail:');
  for (const f of s.findings.slice(0, 20)) {
    lines.push(`    [${f.kind}] claim ${f.claimId}: ${f.detail}`);
  }
  if (s.findings.length > 20) lines.push(`    … and ${s.findings.length - 20} more`);

  return lines.join('\n');
}
