// episteme-core/src/evals/workflow-replay.test.ts
/**
 * These fixtures deliberately include shapes a live database may never yet have
 * produced — a skipped gate, a clock running backwards, an approval with no
 * reviewer. That is the point of replaying against rules rather than against
 * whatever happens to be in storage: the first time one of these appears in
 * production should not also be the first time anyone has checked for it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEPS,
  formatReplay,
  replayAll,
  replayClaim,
  type TransitionRecord,
} from './workflow-replay';

const t = (
  step: string,
  at: string,
  over: Partial<TransitionRecord> = {},
): TransitionRecord => ({ claimId: 'claim-1', step, at, ...over });

/** A well-formed run: every step in order, both gates attributed, inside SLA. */
const HEALTHY: TransitionRecord[] = [
  t(STEPS.validate,  '2026-08-01T09:00:00.000Z'),
  t(STEPS.route,     '2026-08-01T09:00:01.000Z'),
  t(STEPS.adminGate, '2026-08-01T09:00:02.000Z', { suspended: true, actor: 'admin-7' }),
  t(STEPS.hodGate,   '2026-08-01T14:00:00.000Z', { suspended: true, actor: 'hod-3' }),
  t(STEPS.outcome,   '2026-08-02T10:00:00.000Z'),
];

describe('replayClaim — a well-formed run', () => {
  test('produces no findings', () => {
    assert.deepEqual(replayClaim(HEALTHY), []);
  });

  test('out-of-order storage is sorted, not reported as illegal', () => {
    // Storage order is not guaranteed. Misreading an unordered export as a
    // broken workflow would make the harness useless on real data.
    const shuffled = [HEALTHY[3]!, HEALTHY[0]!, HEALTHY[4]!, HEALTHY[1]!, HEALTHY[2]!];
    assert.deepEqual(replayClaim(shuffled), []);
  });

  test('an empty record set yields nothing rather than throwing', () => {
    assert.deepEqual(replayClaim([]), []);
  });
});

describe('replayClaim — transition legality', () => {
  test('skipping the HOD gate is caught', () => {
    // The failure that matters most: a claim approved without the review step
    // the whole workflow exists to enforce.
    const skipped = [
      t(STEPS.validate,  '2026-08-01T09:00:00.000Z'),
      t(STEPS.route,     '2026-08-01T09:00:01.000Z'),
      t(STEPS.adminGate, '2026-08-01T09:00:02.000Z', { suspended: true, actor: 'admin-7' }),
      t(STEPS.outcome,   '2026-08-01T09:00:03.000Z'),
    ];
    const findings = replayClaim(skipped);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'illegal-transition');
    assert.match(findings[0]!.detail, /awaitAdminAssignment -> recordOutcome/);
  });

  test('a run that does not start at validateClaim is caught', () => {
    const findings = replayClaim([
      t(STEPS.route,     '2026-08-01T09:00:00.000Z'),
      t(STEPS.adminGate, '2026-08-01T09:00:01.000Z', { suspended: true, actor: 'a' }),
      t(STEPS.hodGate,   '2026-08-01T09:00:02.000Z', { suspended: true, actor: 'h' }),
      t(STEPS.outcome,   '2026-08-01T09:00:03.000Z'),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'wrong-entry-point');
  });

  test('an unknown step is caught rather than silently accepted', () => {
    // If a step is renamed in the workflow and not here, this fires on every
    // run — the correct failure, since the rules would otherwise be checking a
    // workflow that no longer exists.
    const findings = replayClaim([
      t(STEPS.validate, '2026-08-01T09:00:00.000Z'),
      t('someRenamedStep', '2026-08-01T09:00:01.000Z'),
    ]);
    assert.ok(findings.some((f) => f.kind === 'illegal-transition' && /unknown step/.test(f.detail)));
  });

  test('every problem in a run is reported, not just the first', () => {
    // A run that skipped a gate AND lost its reviewer has two problems, and
    // reporting one would hide the other from whoever has to fix it.
    const findings = replayClaim([
      t(STEPS.validate,  '2026-08-01T09:00:00.000Z'),
      t(STEPS.route,     '2026-08-01T09:00:01.000Z'),
      t(STEPS.adminGate, '2026-08-01T09:00:02.000Z', { suspended: true }), // no actor
      t(STEPS.outcome,   '2026-08-01T09:00:03.000Z'),                      // skips hodGate
    ]);
    const kinds = findings.map((f) => f.kind).sort();
    assert.deepEqual(kinds, ['illegal-transition', 'missing-actor']);
  });
});

describe('replayClaim — audit completeness', () => {
  test('a gate that advanced with no recorded actor is caught', () => {
    // An approval nobody is accountable for is not an approval.
    const findings = replayClaim([
      t(STEPS.validate,  '2026-08-01T09:00:00.000Z'),
      t(STEPS.route,     '2026-08-01T09:00:01.000Z'),
      t(STEPS.adminGate, '2026-08-01T09:00:02.000Z', { suspended: true, actor: 'admin-7' }),
      t(STEPS.hodGate,   '2026-08-01T10:00:00.000Z', { suspended: true }), // no actor
      t(STEPS.outcome,   '2026-08-01T11:00:00.000Z'),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'missing-actor');
    assert.match(findings[0]!.detail, /awaitHodDecision/);
  });

  test('machine steps need no actor', () => {
    // Only the human gates carry accountability; requiring an actor on
    // validateClaim would report noise on every well-formed run.
    assert.deepEqual(replayClaim(HEALTHY), []);
  });

  test('a gate still awaiting a human is not yet missing an actor', () => {
    // The claim is in flight. Demanding a reviewer now would flag every
    // pending claim as an audit failure.
    const findings = replayClaim([
      t(STEPS.validate,  '2026-08-01T09:00:00.000Z'),
      t(STEPS.route,     '2026-08-01T09:00:01.000Z'),
      t(STEPS.adminGate, '2026-08-01T09:00:02.000Z', { suspended: true }),
    ]);
    assert.deepEqual(findings, []);
  });
});

describe('replayClaim — suspension discipline', () => {
  test('a machine step that suspended is caught', () => {
    const findings = replayClaim([
      t(STEPS.validate,  '2026-08-01T09:00:00.000Z'),
      t(STEPS.route,     '2026-08-01T09:00:01.000Z', { suspended: true }),
      t(STEPS.adminGate, '2026-08-01T09:00:02.000Z', { suspended: true, actor: 'a' }),
      t(STEPS.hodGate,   '2026-08-01T09:00:03.000Z', { suspended: true, actor: 'h' }),
      t(STEPS.outcome,   '2026-08-01T09:00:04.000Z'),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'unexpected-suspend');
  });
});

describe('replayClaim — SLA and time', () => {
  test('a gate held past the threshold is a breach', () => {
    const findings = replayClaim([
      t(STEPS.validate,  '2026-08-01T09:00:00.000Z'),
      t(STEPS.route,     '2026-08-01T09:00:01.000Z'),
      t(STEPS.adminGate, '2026-08-01T09:00:02.000Z', { suspended: true, actor: 'admin-7' }),
      t(STEPS.hodGate,   '2026-08-08T09:00:02.000Z', { suspended: true, actor: 'hod-3' }), // 7 days
      t(STEPS.outcome,   '2026-08-08T10:00:00.000Z'),
    ], { slaHours: 72 });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'sla-breach');
    assert.match(findings[0]!.detail, /168\.0h/);
  });

  test('the SLA threshold is configurable', () => {
    const run = [
      t(STEPS.validate,  '2026-08-01T09:00:00.000Z'),
      t(STEPS.route,     '2026-08-01T09:00:01.000Z'),
      t(STEPS.adminGate, '2026-08-01T09:00:02.000Z', { suspended: true, actor: 'a' }),
      t(STEPS.hodGate,   '2026-08-02T09:00:02.000Z', { suspended: true, actor: 'h' }), // 24h
      t(STEPS.outcome,   '2026-08-02T10:00:00.000Z'),
    ];
    assert.deepEqual(replayClaim(run, { slaHours: 72 }), []);
    assert.equal(replayClaim(run, { slaHours: 12 }).length, 1);
  });

  test('SLA is not applied to machine steps', () => {
    // Timing validateClaim would measure the model provider, not the process.
    const findings = replayClaim([
      t(STEPS.validate,  '2026-08-01T09:00:00.000Z'),
      t(STEPS.route,     '2026-08-09T09:00:00.000Z'), // 8 days between machine steps
      t(STEPS.adminGate, '2026-08-09T09:00:01.000Z', { suspended: true, actor: 'a' }),
      t(STEPS.hodGate,   '2026-08-09T09:00:02.000Z', { suspended: true, actor: 'h' }),
      t(STEPS.outcome,   '2026-08-09T09:00:03.000Z'),
    ], { slaHours: 72 });
    assert.deepEqual(findings, []);
  });

  test('a timestamp running backwards is caught', () => {
    const findings = replayClaim([
      t(STEPS.validate, '2026-08-01T09:00:00.000Z'),
      t(STEPS.route,    '2026-08-01T08:00:00.000Z'),
    ]);
    // Sorting puts route first, so this surfaces as a wrong entry point — the
    // record set is corrupt either way, and both readings say so.
    assert.ok(findings.length > 0);
  });

  test('an unparseable timestamp is reported rather than crashing', () => {
    const findings = replayClaim([
      t(STEPS.validate, '2026-08-01T09:00:00.000Z'),
      t(STEPS.route,    'not-a-date'),
    ]);
    assert.ok(findings.some((f) => f.kind === 'time-travel'));
  });
});

describe('replayClaim — completeness', () => {
  test('an in-flight claim is not a defect by default', () => {
    // A claim legitimately mid-review at export time must not be flagged, or
    // every export is noisy.
    const inFlight = HEALTHY.slice(0, 4);
    assert.deepEqual(replayClaim(inFlight), []);
  });

  test('requireTerminal flags a run that never reached an outcome', () => {
    const findings = replayClaim(HEALTHY.slice(0, 4), { requireTerminal: true });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'incomplete');
  });
});

describe('replayAll', () => {
  const other = (step: string, at: string, over: Partial<TransitionRecord> = {}) =>
    ({ ...t(step, at, over), claimId: 'claim-2' });

  test('groups by claim and counts clean runs', () => {
    const summary = replayAll([
      ...HEALTHY,
      other(STEPS.validate,  '2026-08-03T09:00:00.000Z'),
      other(STEPS.route,     '2026-08-03T09:00:01.000Z'),
      other(STEPS.outcome,   '2026-08-03T09:00:02.000Z'), // skips both gates
    ]);
    assert.equal(summary.claimsReplayed, 2);
    assert.equal(summary.claimsClean, 1);
    assert.equal(summary.completed, 2);
    assert.equal(summary.byKind['illegal-transition'], 1);
  });

  test('no records means nothing was verified', () => {
    const summary = replayAll([]);
    assert.equal(summary.claimsReplayed, 0);
    assert.deepEqual(summary.findings, []);
  });
});

describe('formatReplay', () => {
  test('an empty replay refuses to read as a pass', () => {
    // The dangerous output: a workflow that never ran reporting green.
    const out = formatReplay(replayAll([]));
    assert.match(out, /UNVERIFIED/);
    assert.match(out, /This is not a pass/);
  });

  test('a clean replay says the audit trail is complete', () => {
    const out = formatReplay(replayAll(HEALTHY));
    assert.match(out, /clean\s+1\/1/);
    assert.match(out, /legal transition sequence with a complete audit trail/);
  });

  test('findings are grouped by kind and then detailed', () => {
    const out = formatReplay(replayAll([
      t(STEPS.validate,  '2026-08-01T09:00:00.000Z'),
      t(STEPS.route,     '2026-08-01T09:00:01.000Z'),
      t(STEPS.adminGate, '2026-08-01T09:00:02.000Z', { suspended: true }),
      t(STEPS.outcome,   '2026-08-01T09:00:03.000Z'),
    ]));
    assert.match(out, /findings by kind/);
    assert.match(out, /illegal-transition/);
    assert.match(out, /missing-actor/);
  });
});
