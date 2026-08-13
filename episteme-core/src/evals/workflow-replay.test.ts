// episteme-core/src/evals/workflow-replay.test.ts
/**
 * These fixtures are claim_status histories as Supabase records them, not Mastra
 * step traces. That distinction is the point: Mastra's workflow store is
 * per-instance and local in production, so a replay built on step names would
 * examine zero rows forever while reporting green.
 *
 * Several fixtures below are shapes production may never yet have produced — a
 * claim approved without review, a clock running backwards, a decision with no
 * reviewer. The first time one of those appears in a live claim should not also
 * be the first time anyone checked for it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS,
  formatReplay,
  replayAll,
  replayClaim,
  type TransitionRecord,
} from './workflow-replay';

const t = (
  status: string,
  at: string,
  over: Partial<TransitionRecord> = {},
): TransitionRecord => ({ claimId: 'claim-1', status, at, ...over });

/** A well-formed claim: created, reviewed, decided by a named reviewer, in SLA. */
const HEALTHY: TransitionRecord[] = [
  t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
  t(STATUS.inReview, '2026-08-01T11:00:00.000Z', { actor: 'admin-7' }),
  t(STATUS.approved, '2026-08-02T10:00:00.000Z', { actor: 'hod-3' }),
];

describe('replayClaim — a well-formed claim', () => {
  test('produces no findings', () => {
    assert.deepEqual(replayClaim(HEALTHY), []);
  });

  test('a rejection is equally clean', () => {
    assert.deepEqual(replayClaim([
      t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
      t(STATUS.inReview, '2026-08-01T11:00:00.000Z', { actor: 'admin-7' }),
      t(STATUS.rejected, '2026-08-02T10:00:00.000Z', { actor: 'hod-3' }),
    ]), []);
  });

  test('out-of-order storage is sorted, not reported as illegal', () => {
    const shuffled = [HEALTHY[2]!, HEALTHY[0]!, HEALTHY[1]!];
    assert.deepEqual(replayClaim(shuffled), []);
  });

  test('an empty history yields nothing rather than throwing', () => {
    assert.deepEqual(replayClaim([]), []);
  });
});

describe('replayClaim — transition legality', () => {
  test('approval without entering review is caught', () => {
    // THE finding this harness exists for: a claim decided without the review
    // step the whole workflow is built to enforce.
    const findings = replayClaim([
      t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
      t(STATUS.approved, '2026-08-01T09:05:00.000Z', { actor: 'admin-7' }),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'illegal-transition');
    assert.match(findings[0]!.detail, /"pending" -> "approved"/);
  });

  test('rejection without entering review is caught', () => {
    const findings = replayClaim([
      t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
      t(STATUS.rejected, '2026-08-01T09:05:00.000Z', { actor: 'admin-7' }),
    ]);
    assert.equal(findings[0]!.kind, 'illegal-transition');
  });

  test('cancelling from pending is legal', () => {
    // A claimant withdrawing before review is ordinary, not a violation.
    assert.deepEqual(replayClaim([
      t(STATUS.pending,   '2026-08-01T09:00:00.000Z'),
      t(STATUS.cancelled, '2026-08-01T10:00:00.000Z', { actor: 'user-1' }),
    ]), []);
  });

  test('cancelling from review is legal', () => {
    assert.deepEqual(replayClaim([
      t(STATUS.pending,   '2026-08-01T09:00:00.000Z'),
      t(STATUS.inReview,  '2026-08-01T10:00:00.000Z', { actor: 'admin-7' }),
      t(STATUS.cancelled, '2026-08-01T11:00:00.000Z', { actor: 'user-1' }),
    ]), []);
  });

  test('a claim that does not begin as pending is caught', () => {
    const findings = replayClaim([
      t(STATUS.inReview, '2026-08-01T09:00:00.000Z', { actor: 'admin-7' }),
      t(STATUS.approved, '2026-08-01T10:00:00.000Z', { actor: 'hod-3' }),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'wrong-entry-point');
  });

  test('a change after a terminal status is caught', () => {
    // Reopening a decided claim in place destroys the audit trail: the record
    // no longer shows what was decided or when.
    const findings = replayClaim([
      t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
      t(STATUS.inReview, '2026-08-01T10:00:00.000Z', { actor: 'admin-7' }),
      t(STATUS.approved, '2026-08-02T10:00:00.000Z', { actor: 'hod-3' }),
      t(STATUS.inReview, '2026-08-03T10:00:00.000Z', { actor: 'admin-7' }),
    ]);
    assert.ok(findings.some((f) => f.kind === 'post-terminal-change'));
  });

  test('an unknown status is caught rather than silently accepted', () => {
    // If claim_status gains a member and this file is not updated, it fires —
    // the correct failure, since the rules would otherwise be checking an
    // enum that no longer matches the database.
    const findings = replayClaim([
      t(STATUS.pending, '2026-08-01T09:00:00.000Z'),
      t('escalated',    '2026-08-01T10:00:00.000Z'),
    ]);
    assert.ok(findings.some((f) => /unknown status/.test(f.detail)));
  });

  test('every problem is reported, not just the first', () => {
    const findings = replayClaim([
      t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
      t(STATUS.approved, '2026-08-01T09:05:00.000Z'), // skips review AND no actor
    ]);
    assert.deepEqual(findings.map((f) => f.kind).sort(), ['illegal-transition', 'missing-actor']);
  });
});

describe('replayClaim — audit completeness', () => {
  test('an approval with no recorded actor is caught', () => {
    const findings = replayClaim([
      t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
      t(STATUS.inReview, '2026-08-01T10:00:00.000Z', { actor: 'admin-7' }),
      t(STATUS.approved, '2026-08-02T10:00:00.000Z'),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'missing-actor');
  });

  test('a rejection with no recorded actor is caught', () => {
    const findings = replayClaim([
      t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
      t(STATUS.inReview, '2026-08-01T10:00:00.000Z', { actor: 'admin-7' }),
      t(STATUS.rejected, '2026-08-02T10:00:00.000Z', { actor: null }),
    ]);
    assert.equal(findings[0]!.kind, 'missing-actor');
  });

  test('a cancellation needs no reviewer', () => {
    // A claimant withdrawing their own request is not a decision anyone else
    // is accountable for. Requiring one would flag every ordinary withdrawal.
    assert.deepEqual(replayClaim([
      t(STATUS.pending,   '2026-08-01T09:00:00.000Z'),
      t(STATUS.cancelled, '2026-08-01T10:00:00.000Z'),
    ]), []);
  });

  test('the creation row needs no actor', () => {
    assert.deepEqual(replayClaim(HEALTHY), []);
  });
});

describe('replayClaim — SLA and time', () => {
  test('a claim left too long in review breaches SLA', () => {
    const findings = replayClaim([
      t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
      t(STATUS.inReview, '2026-08-01T10:00:00.000Z', { actor: 'admin-7' }),
      t(STATUS.approved, '2026-08-08T10:00:00.000Z', { actor: 'hod-3' }), // 7 days in review
    ], { slaHours: 72 });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'sla-breach');
    assert.match(findings[0]!.detail, /in_review.*168\.0h/);
  });

  test('a claim left too long unassigned breaches SLA', () => {
    const findings = replayClaim([
      t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
      t(STATUS.inReview, '2026-08-10T09:00:00.000Z', { actor: 'admin-7' }), // 9 days pending
      t(STATUS.approved, '2026-08-10T10:00:00.000Z', { actor: 'hod-3' }),
    ], { slaHours: 72 });
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.detail, /in "pending"/);
  });

  test('the threshold is configurable', () => {
    const run = [
      t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
      t(STATUS.inReview, '2026-08-01T10:00:00.000Z', { actor: 'a' }),
      t(STATUS.approved, '2026-08-02T10:00:00.000Z', { actor: 'h' }), // 24h in review
    ];
    assert.deepEqual(replayClaim(run, { slaHours: 72 }), []);
    assert.equal(replayClaim(run, { slaHours: 12 }).length, 1);
  });

  test('a timestamp running backwards is caught', () => {
    const findings = replayClaim([
      t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
      t(STATUS.inReview, '2026-08-01T08:00:00.000Z', { actor: 'admin-7' }),
    ]);
    // Sorting puts in_review first, so this surfaces as a wrong entry point.
    // The history is corrupt either way and both readings say so.
    assert.ok(findings.length > 0);
  });

  test('an unparseable timestamp is reported rather than crashing', () => {
    const findings = replayClaim([
      t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
      t(STATUS.inReview, 'not-a-date', { actor: 'admin-7' }),
    ]);
    assert.ok(findings.some((f) => f.kind === 'time-travel'));
  });
});

describe('replayClaim — completeness', () => {
  test('a claim still under review is not a defect by default', () => {
    assert.deepEqual(replayClaim(HEALTHY.slice(0, 2)), []);
  });

  test('requireTerminal flags a claim that never resolved', () => {
    const findings = replayClaim(HEALTHY.slice(0, 2), { requireTerminal: true });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'incomplete');
  });
});

describe('replayAll', () => {
  const other = (status: string, at: string, over: Partial<TransitionRecord> = {}) =>
    ({ ...t(status, at, over), claimId: 'claim-2' });

  test('groups by claim, counts clean runs and outcome distribution', () => {
    const summary = replayAll([
      ...HEALTHY,
      other(STATUS.pending,  '2026-08-03T09:00:00.000Z'),
      other(STATUS.approved, '2026-08-03T09:05:00.000Z', { actor: 'admin-9' }), // skips review
    ]);
    assert.equal(summary.claimsReplayed, 2);
    assert.equal(summary.claimsClean, 1);
    assert.equal(summary.completed, 2);
    assert.equal(summary.byKind['illegal-transition'], 1);
    assert.deepEqual(summary.outcomes, { approved: 2 });
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
    assert.match(out, /NOT a pass/);
  });

  test('a clean replay reports the outcome distribution', () => {
    const out = formatReplay(replayAll(HEALTHY));
    assert.match(out, /clean\s+1\/1/);
    assert.match(out, /outcomes\s+approved 1/);
    assert.match(out, /legal status sequence with a complete audit trail/);
  });

  test('findings are grouped by kind and then detailed', () => {
    const out = formatReplay(replayAll([
      t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
      t(STATUS.approved, '2026-08-01T09:05:00.000Z'),
    ]));
    assert.match(out, /findings by kind/);
    assert.match(out, /illegal-transition/);
    assert.match(out, /missing-actor/);
  });
});
