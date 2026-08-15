// episteme-core/src/evals/workflow-replay.test.ts
/**
 * Fixtures are claim_status histories as Supabase records them, with claim
 * identity carried as CASE attributes rather than repeated on every event.
 *
 * Several shapes below may never yet have occurred in production — a claimant
 * approving their own request, a router deciding their own routing, a reviewer
 * from another institution. The first time one appears in a live claim should
 * not also be the first time anyone checked for it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS,
  formatReplay,
  replayAll,
  replayClaim,
  type ClaimHistory,
  type ClaimRecord,
  type TransitionRecord,
} from './workflow-replay';

const CLAIMANT = 'user-student-1';
const ADMIN    = 'user-admin-7';
const HOD      = 'user-hod-3';
const UNIBEN   = 'inst-uniben';
const OTHER    = 'inst-elsewhere';

function claim(over: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    claimId: 'claim-1',
    userId: CLAIMANT,
    claimType: 'transcript',
    institutionId: UNIBEN,
    assignedBy: ADMIN,
    assignedTo: HOD,
    reviewerId: HOD,
    autoRouted: false,
    reviewerInstitutionId: UNIBEN,
    ...over,
  };
}

const t = (status: string, at: string, over: Partial<TransitionRecord> = {}): TransitionRecord =>
  ({ claimId: 'claim-1', status, at, ...over });

/** Created, routed by an admin, decided by a different HOD, in institution, in SLA. */
const HEALTHY: ClaimHistory = {
  claim: claim(),
  transitions: [
    t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
    t(STATUS.inReview, '2026-08-01T11:00:00.000Z', { actor: ADMIN }),
    t(STATUS.approved, '2026-08-02T10:00:00.000Z', { actor: HOD }),
  ],
};

describe('replayClaim — a well-formed claim', () => {
  test('produces no findings', () => {
    assert.deepEqual(replayClaim(HEALTHY), []);
  });

  test('out-of-order storage is sorted, not reported as illegal', () => {
    const shuffled = {
      claim: HEALTHY.claim,
      transitions: [HEALTHY.transitions[2]!, HEALTHY.transitions[0]!, HEALTHY.transitions[1]!],
    };
    assert.deepEqual(replayClaim(shuffled), []);
  });
});

describe('replayClaim — separation of duties', () => {
  test('a claimant approving their own claim is CRITICAL', () => {
    // The single most serious failure a verification workflow can have, and one
    // the previous version of this harness passed silently.
    const findings = replayClaim({
      claim: claim({ reviewerId: CLAIMANT, reviewerInstitutionId: UNIBEN }),
      transitions: HEALTHY.transitions,
    });
    const selfReview = findings.find((f) => f.kind === 'self-review');
    assert.ok(selfReview, `expected self-review, got ${findings.map((f) => f.kind).join(', ')}`);
    assert.equal(selfReview!.severity, 'critical');
  });

  test('the same person routing and deciding breaches dual control', () => {
    const findings = replayClaim({
      claim: claim({ assignedBy: HOD, reviewerId: HOD }),
      transitions: HEALTHY.transitions,
    });
    const dual = findings.find((f) => f.kind === 'dual-control');
    assert.ok(dual);
    assert.equal(dual!.severity, 'high');
  });

  test('an auto-routed claim is exempt from dual control', () => {
    // The system assigned it, so there is no second human to be distinct from.
    // Flagging these would report every routed claim as a control failure.
    assert.deepEqual(replayClaim({
      claim: claim({ autoRouted: true, assignedBy: HOD, reviewerId: HOD }),
      transitions: HEALTHY.transitions,
    }), []);
  });

  test('a reviewer from another institution is CRITICAL', () => {
    const findings = replayClaim({
      claim: claim({ reviewerInstitutionId: OTHER }),
      transitions: HEALTHY.transitions,
    });
    const scope = findings.find((f) => f.kind === 'authority-scope');
    assert.ok(scope);
    assert.equal(scope!.severity, 'critical');
  });

  test('an unresolved reviewer institution SKIPS the scope check rather than passing it', () => {
    // An unresolved join must never read as compliance. The claim is silent
    // here and counted separately in the summary.
    const findings = replayClaim({
      claim: claim({ reviewerInstitutionId: null }),
      transitions: HEALTHY.transitions,
    });
    assert.deepEqual(findings.filter((f) => f.kind === 'authority-scope'), []);
  });

  test('duty controls fire even with no surviving transition history', () => {
    // A claim row alone is enough to show it was self-approved. The controls
    // must not depend on audit_logs being complete.
    const findings = replayClaim({
      claim: claim({ reviewerId: CLAIMANT }),
      transitions: [],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'self-review');
  });

  test('an undecided claim raises no duty findings', () => {
    assert.deepEqual(replayClaim({
      claim: claim({ reviewerId: null }),
      transitions: [t(STATUS.pending, '2026-08-01T09:00:00.000Z')],
    }), []);
  });
});

describe('replayClaim — transition legality', () => {
  test('reaching a decision from pending is approval-without-review, and CRITICAL', () => {
    // Separated from ordinary illegal transitions: this means the review never
    // happened, not merely that the process deviated.
    const findings = replayClaim({
      claim: claim(),
      transitions: [
        t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
        t(STATUS.approved, '2026-08-01T09:05:00.000Z', { actor: HOD }),
      ],
    });
    const f = findings.find((x) => x.kind === 'approval-without-review');
    assert.ok(f);
    assert.equal(f!.severity, 'critical');
  });

  test('cancelling from pending is legal', () => {
    assert.deepEqual(replayClaim({
      claim: claim({ reviewerId: null }),
      transitions: [
        t(STATUS.pending,   '2026-08-01T09:00:00.000Z'),
        t(STATUS.cancelled, '2026-08-01T10:00:00.000Z', { actor: CLAIMANT }),
      ],
    }), []);
  });

  test('reopening a decided claim is recorded as advisory, not a violation', () => {
    // fn_admin_reopen_claim exists, so approved -> in_review is a SUPPORTED
    // operation. Flagging it as a control failure would report every legitimate
    // reopen. It stays visible in the audit trail as advisory.
    const findings = replayClaim({
      claim: claim(),
      transitions: [
        ...HEALTHY.transitions,
        t(STATUS.inReview, '2026-08-03T10:00:00.000Z', { actor: ADMIN }),
      ],
    });
    const reopen = findings.find((f) => f.kind === 'reopened');
    assert.ok(reopen, `got ${findings.map((f) => f.kind).join(', ')}`);
    assert.equal(reopen!.severity, 'advisory');
    assert.ok(!findings.some((f) => f.kind === 'post-terminal-change'));
  });

  test('a terminal status moving anywhere else has no supported path and stays high', () => {
    // There is no RPC that turns a rejected claim into an approved one in place.
    // That shape rewrites the decision without a record of the review.
    const findings = replayClaim({
      claim: claim(),
      transitions: [
        t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
        t(STATUS.inReview, '2026-08-01T10:00:00.000Z', { actor: ADMIN }),
        t(STATUS.rejected, '2026-08-02T10:00:00.000Z', { actor: HOD }),
        t(STATUS.approved, '2026-08-03T10:00:00.000Z', { actor: HOD }),
      ],
    });
    const f = findings.find((x) => x.kind === 'post-terminal-change');
    assert.ok(f, `got ${findings.map((x) => x.kind).join(', ')}`);
    assert.equal(f!.severity, 'high');
  });

  test('a configured SLA overrides the fallback', () => {
    // claim_sla_rules.hod_sla_hours is per claim type per institution. Measuring
    // against a constant invented in the harness would report breaches of a
    // threshold nobody agreed to, and miss breaches of the one they did.
    const history = {
      claim: claim({ slaHours: 12 }),
      transitions: [
        t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
        t(STATUS.inReview, '2026-08-01T10:00:00.000Z', { actor: ADMIN }),
        t(STATUS.approved, '2026-08-02T10:00:00.000Z', { actor: HOD }), // 24h in review
      ],
    };
    const findings = replayClaim(history, { slaHours: 72 });
    assert.equal(findings.length, 1, 'the claim rule of 12h wins over the 72h fallback');
    assert.match(findings[0]!.detail, /configured threshold/);
  });

  test('the fallback is used and labelled when a claim has no rule', () => {
    const findings = replayClaim({
      claim: claim({ slaHours: null }),
      transitions: [
        t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
        t(STATUS.inReview, '2026-08-01T10:00:00.000Z', { actor: ADMIN }),
        t(STATUS.approved, '2026-08-05T10:00:00.000Z', { actor: HOD }),
      ],
    }, { slaHours: 24 });
    assert.match(findings[0]!.detail, /fallback threshold/);
  });

  test('a claim not beginning at pending is advisory, not critical', () => {
    const findings = replayClaim({
      claim: claim(),
      transitions: [
        t(STATUS.inReview, '2026-08-01T09:00:00.000Z', { actor: ADMIN }),
        t(STATUS.approved, '2026-08-01T10:00:00.000Z', { actor: HOD }),
      ],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'wrong-entry-point');
    assert.equal(findings[0]!.severity, 'advisory');
  });

  test('an unknown status is caught rather than silently accepted', () => {
    const findings = replayClaim({
      claim: claim(),
      transitions: [
        t(STATUS.pending, '2026-08-01T09:00:00.000Z'),
        t('escalated',    '2026-08-01T10:00:00.000Z'),
      ],
    });
    assert.ok(findings.some((f) => /unknown status/.test(f.detail)));
  });

  test('every problem is reported, not just the first', () => {
    // Self-approved AND without review. Reporting one would hide the other.
    const findings = replayClaim({
      claim: claim({ reviewerId: CLAIMANT }),
      transitions: [
        t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
        t(STATUS.approved, '2026-08-01T09:05:00.000Z'),
      ],
    });
    assert.deepEqual(
      findings.map((f) => f.kind).sort(),
      ['approval-without-review', 'missing-actor', 'self-review'],
    );
  });
});

describe('replayClaim — audit completeness', () => {
  test('an approval with no recorded actor is high severity', () => {
    const findings = replayClaim({
      claim: claim(),
      transitions: [
        t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
        t(STATUS.inReview, '2026-08-01T10:00:00.000Z', { actor: ADMIN }),
        t(STATUS.approved, '2026-08-02T10:00:00.000Z'),
      ],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'missing-actor');
    assert.equal(findings[0]!.severity, 'high');
  });

  test('a cancellation needs no reviewer', () => {
    assert.deepEqual(replayClaim({
      claim: claim({ reviewerId: null }),
      transitions: [
        t(STATUS.pending,   '2026-08-01T09:00:00.000Z'),
        t(STATUS.cancelled, '2026-08-01T10:00:00.000Z'),
      ],
    }), []);
  });
});

describe('replayClaim — SLA and time', () => {
  test('a claim left too long in review breaches SLA as advisory', () => {
    const findings = replayClaim({
      claim: claim(),
      transitions: [
        t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
        t(STATUS.inReview, '2026-08-01T10:00:00.000Z', { actor: ADMIN }),
        t(STATUS.approved, '2026-08-08T10:00:00.000Z', { actor: HOD }),
      ],
    }, { slaHours: 72 });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'sla-breach');
    assert.equal(findings[0]!.severity, 'advisory');
  });

  test('an unparseable timestamp is reported rather than crashing', () => {
    const findings = replayClaim({
      claim: claim(),
      transitions: [
        t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
        t(STATUS.inReview, 'not-a-date', { actor: ADMIN }),
      ],
    });
    assert.ok(findings.some((f) => f.kind === 'time-travel'));
  });
});

describe('replayAll', () => {
  test('counts severity and outcome distribution across claims', () => {
    const bad: ClaimHistory = {
      claim: { ...claim({ reviewerId: CLAIMANT }), claimId: 'claim-2' },
      transitions: [
        { claimId: 'claim-2', status: STATUS.pending,  at: '2026-08-03T09:00:00.000Z' },
        { claimId: 'claim-2', status: STATUS.approved, at: '2026-08-03T09:05:00.000Z', actor: CLAIMANT },
      ],
    };
    const s = replayAll([HEALTHY, bad], {}, 'full');
    assert.equal(s.claimsReplayed, 2);
    assert.equal(s.claimsClean, 1);
    assert.equal(s.bySeverity.critical, 2, 'self-review and approval-without-review');
    assert.deepEqual(s.outcomes, { approved: 2 });
  });

  test('unresolved reviewer institutions are counted, not ignored', () => {
    const s = replayAll([{
      claim: claim({ reviewerInstitutionId: null }),
      transitions: HEALTHY.transitions,
    }], {}, 'full');
    assert.equal(s.authorityScopeUnresolved, 1);
  });
});

describe('formatReplay — population and severity', () => {
  test('an empty replay refuses to read as a pass', () => {
    const out = formatReplay(replayAll([], {}, 'full'));
    assert.match(out, /UNVERIFIED/);
    assert.match(out, /NOT a pass/);
  });

  test('a partial population is warned about before any figure is read', () => {
    // The failure this repo has already produced twice: a green result over
    // rows the query happened to be allowed to see.
    const out = formatReplay(replayAll([HEALTHY], {}, 'rls-limited'));
    assert.match(out, /population scope is "rls-limited"/);
    assert.match(out, /is not evidence/);
  });

  test('a full-population clean run states the duty result explicitly', () => {
    const out = formatReplay(replayAll([HEALTHY], {}, 'full'));
    assert.ok(!out.includes('WARNING'));
    assert.match(out, /no decision was made by its own subject/);
  });

  test('findings are ordered most severe first', () => {
    const out = formatReplay(replayAll([{
      claim: claim({ reviewerId: CLAIMANT }),
      transitions: [
        t(STATUS.pending,  '2026-08-01T09:00:00.000Z'),
        t(STATUS.inReview, '2026-08-01T10:00:00.000Z', { actor: ADMIN }),
        t(STATUS.approved, '2026-08-20T10:00:00.000Z', { actor: CLAIMANT }),
      ],
    }], { slaHours: 72 }, 'full'));

    assert.match(out, /findings by severity/);
    assert.ok(
      out.indexOf('[critical/self-review]') < out.indexOf('[advisory/sla-breach]'),
      'critical findings must precede advisory ones',
    );
  });

  test('a skipped authority-scope check is surfaced, not silently omitted', () => {
    const out = formatReplay(replayAll([{
      claim: claim({ reviewerInstitutionId: null }),
      transitions: HEALTHY.transitions,
    }], {}, 'full'));
    assert.match(out, /authority-scope control was SKIPPED/);
  });
});
