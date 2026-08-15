// episteme-core/src/evals/claim-history.test.ts
/**
 * The derivation's job is to lose nothing that matters. Most of these tests
 * assert that a BROKEN row still produces a history in which workflow-replay
 * finds the break — because the tempting bug here is to normalise rows into a
 * legal-looking sequence and erase the finding on the way in.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { claimHistoriesFromRows, claimHistoryFromRow, type ClaimRow } from './claim-history';
import { STATUS, replayClaim } from './workflow-replay';

const CLAIMANT = 'user-student-1';
const ADMIN    = 'user-admin-7';
const HOD      = 'user-hod-3';
const UNIBEN   = 'inst-uniben';

function row(over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: 'claim-1',
    user_id: CLAIMANT,
    claim_type: 'transcript',
    institution_id: UNIBEN,
    department_id: null,
    assigned_by: ADMIN,
    assigned_to: HOD,
    reviewer_id: HOD,
    auto_routed: false,
    status: STATUS.approved,
    created_at:  '2026-08-01T09:00:00.000Z',
    assigned_at: '2026-08-01T11:00:00.000Z',
    reviewed_at: '2026-08-02T10:00:00.000Z',
    updated_at:  '2026-08-02T10:00:00.000Z',
    ...over,
  };
}

describe('claimHistoryFromRow — the ordinary path', () => {
  test('derives pending, in_review and the outcome, each attributed', () => {
    const { transitions } = claimHistoryFromRow(row());
    assert.deepEqual(transitions.map((t) => t.status), [
      STATUS.pending, STATUS.inReview, STATUS.approved,
    ]);
    assert.equal(transitions[0]!.actor, CLAIMANT, 'the claimant submits');
    assert.equal(transitions[1]!.actor, ADMIN,    'the assigner starts review');
    assert.equal(transitions[2]!.actor, HOD,      'the reviewer decides');
  });

  test('a well-formed row replays clean', () => {
    // The end-to-end check: derivation feeds replay and nothing is invented.
    assert.deepEqual(replayClaim(claimHistoryFromRow(row(), {
      reviewerInstitutionId: UNIBEN,
    })), []);
  });

  test('case attributes come across intact', () => {
    const { claim } = claimHistoryFromRow(row(), {
      reviewerInstitutionId: UNIBEN, slaHours: 48,
    });
    assert.equal(claim.userId, CLAIMANT);
    assert.equal(claim.reviewerId, HOD);
    assert.equal(claim.assignedBy, ADMIN);
    assert.equal(claim.institutionId, UNIBEN);
    assert.equal(claim.reviewerInstitutionId, UNIBEN);
    assert.equal(claim.slaHours, 48);
    assert.equal(claim.autoRouted, false);
  });

  test('a claim still pending yields one transition', () => {
    const { transitions } = claimHistoryFromRow(row({
      status: STATUS.pending, assigned_at: null, reviewed_at: null, reviewer_id: null,
    }));
    assert.deepEqual(transitions.map((t) => t.status), [STATUS.pending]);
  });

  test('a claim under review yields two', () => {
    const { transitions } = claimHistoryFromRow(row({
      status: STATUS.inReview, reviewed_at: null, reviewer_id: null,
    }));
    assert.deepEqual(transitions.map((t) => t.status), [STATUS.pending, STATUS.inReview]);
  });
});

describe('claimHistoryFromRow — a broken row must stay broken', () => {
  test('an approval with no assignment derives pending -> approved, and replay catches it', () => {
    // THE case that matters. The row carries no evidence review ever happened.
    // Inventing an in_review step to make the sequence look legal would erase
    // the finding on the way in.
    const history = claimHistoryFromRow(row({ assigned_at: null }), {
      reviewerInstitutionId: UNIBEN,
    });
    assert.deepEqual(history.transitions.map((t) => t.status), [
      STATUS.pending, STATUS.approved,
    ]);

    const findings = replayClaim(history);
    const critical = findings.find((f) => f.kind === 'approval-without-review');
    assert.ok(critical, `got ${findings.map((f) => f.kind).join(', ')}`);
    assert.equal(critical!.severity, 'critical');
  });

  test('a self-approved row survives derivation and is caught', () => {
    const findings = replayClaim(claimHistoryFromRow(
      row({ reviewer_id: CLAIMANT }),
      { reviewerInstitutionId: UNIBEN },
    ));
    assert.ok(findings.some((f) => f.kind === 'self-review'));
  });

  test('a cross-institution reviewer survives derivation and is caught', () => {
    const findings = replayClaim(claimHistoryFromRow(row(), {
      reviewerInstitutionId: 'inst-elsewhere',
    }));
    assert.ok(findings.some((f) => f.kind === 'authority-scope'));
  });

  test('a decision with no timestamp is emitted, not dropped', () => {
    // Dropping it would show a claim that never resolved — a cleaner-looking
    // history than the truth. Emitted with an empty timestamp so replay reports
    // it as unparseable.
    const { transitions } = claimHistoryFromRow(row({
      reviewed_at: null, updated_at: null,
    }));
    assert.equal(transitions.length, 3);
    assert.equal(transitions[2]!.at, '');
    assert.ok(replayClaim({ claim: claimHistoryFromRow(row({
      reviewed_at: null, updated_at: null,
    })).claim, transitions }).some((f) => f.kind === 'time-travel'));
  });
});

describe('claimHistoryFromRow — enrichment absence', () => {
  test('a missing reviewer institution becomes null, so the scope check SKIPS', () => {
    // Never defaults to the claim's own institution, which would manufacture a
    // pass for a control that was never evaluated.
    const { claim } = claimHistoryFromRow(row(), {});
    assert.equal(claim.reviewerInstitutionId, null);
    assert.deepEqual(
      replayClaim({ claim, transitions: claimHistoryFromRow(row()).transitions })
        .filter((f) => f.kind === 'authority-scope'),
      [],
    );
  });

  test('a missing SLA rule becomes null so the replay fallback applies', () => {
    assert.equal(claimHistoryFromRow(row(), {}).claim.slaHours, null);
  });
});

describe('claimHistoryFromRow — cancellation', () => {
  test('a cancellation with no reviewed_at is timed by updated_at', () => {
    const { transitions } = claimHistoryFromRow(row({
      status: STATUS.cancelled, reviewer_id: null, reviewed_at: null,
      assigned_at: null, updated_at: '2026-08-01T12:00:00.000Z',
    }));
    assert.deepEqual(transitions.map((t) => t.status), [STATUS.pending, STATUS.cancelled]);
    assert.equal(transitions[1]!.at, '2026-08-01T12:00:00.000Z');
  });

  test('a cancellation is attributed to the claimant when no reviewer is named', () => {
    const { transitions } = claimHistoryFromRow(row({
      status: STATUS.cancelled, reviewer_id: null, reviewed_at: null, assigned_at: null,
    }));
    assert.equal(transitions[1]!.actor, CLAIMANT);
  });

  test('a cancellation replays clean', () => {
    assert.deepEqual(replayClaim(claimHistoryFromRow(row({
      status: STATUS.cancelled, reviewer_id: null, reviewed_at: null, assigned_at: null,
    }))), []);
  });
});

describe('claimHistoryFromRow — auto-routed claims', () => {
  test('an auto-routed claim carries a null assigner and stays exempt', () => {
    const history = claimHistoryFromRow(
      row({ auto_routed: true, assigned_by: null, reviewer_id: HOD }),
      { reviewerInstitutionId: UNIBEN },
    );
    assert.equal(history.claim.autoRouted, true);
    assert.equal(history.transitions[1]!.actor, null);
    assert.deepEqual(replayClaim(history), []);
  });
});

describe('claimHistoriesFromRows', () => {
  test('maps a page and applies enrichment by claim id', () => {
    const rows = [row(), { ...row(), id: 'claim-2' }];
    const histories = claimHistoriesFromRows(rows, new Map([
      ['claim-1', { reviewerInstitutionId: UNIBEN, slaHours: 24 }],
      ['claim-2', { reviewerInstitutionId: 'inst-elsewhere' }],
    ]));
    assert.equal(histories.length, 2);
    assert.equal(histories[0]!.claim.slaHours, 24);
    assert.equal(histories[1]!.claim.reviewerInstitutionId, 'inst-elsewhere');
  });

  test('a row with no enrichment entry still maps', () => {
    const histories = claimHistoriesFromRows([row()]);
    assert.equal(histories[0]!.claim.reviewerInstitutionId, null);
  });
});
