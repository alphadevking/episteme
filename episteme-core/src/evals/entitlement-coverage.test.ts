// episteme-core/src/evals/entitlement-coverage.test.ts
/**
 * The scenario in the first suite is not hypothetical: it is the 2026-08-13
 * corpus, in which the entitlement eval reported "4/4, 0 violations" while two
 * of its four cases asserted about namespaces holding zero vectors.
 *
 * A security check that cannot fail is worse than one that does, because it
 * gets written up as evidence. These tests pin the detector that says so.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessExclusionCoverage,
  formatExclusionCoverage,
  knownNamespaces,
} from './entitlement-coverage';

/** The index as it actually stood: three namespaces, nothing else. */
const REAL_CENSUS = {
  general: 391,
  admissions: 55,
  'academic-policy': 12,
};

const UNIVERSE = [
  'academic-policy',
  'admissions',
  'financial-aid',
  'general',
  'programmes',
  'staff-internal',
];

describe('assessExclusionCoverage — the 2026-08-13 corpus', () => {
  test('a trust-2 student\'s academic-policy exclusion is genuinely enforced', () => {
    // academic-policy holds 12 vectors and opens only at trust 3, so keeping it
    // out of a trust-2 caller's results is a real, falsifiable check.
    const c = assessExclusionCoverage(
      ['admissions', 'programmes', 'general'],
      UNIVERSE,
      REAL_CENSUS,
    );
    assert.ok(c.enforced.includes('academic-policy'));
    assert.equal(c.vectorsWithheld, 12);
    assert.equal(c.whollyVacuous, false);
  });

  test('financial-aid and staff-internal exclusions are exposed as vacuous', () => {
    // The finding that prompted this module. Both are empty; asserting they do
    // not leak proves nothing.
    const c = assessExclusionCoverage(
      ['admissions', 'programmes', 'general'],
      UNIVERSE,
      REAL_CENSUS,
    );
    assert.ok(c.vacuous.includes('financial-aid'));
    assert.ok(c.vacuous.includes('staff-internal'));
  });

  test('a case resting only on empty namespaces is flagged wholly vacuous', () => {
    const c = assessExclusionCoverage(
      ['general', 'admissions', 'academic-policy', 'programmes'],
      UNIVERSE,
      REAL_CENSUS,
    );
    assert.deepEqual(c.enforced, []);
    assert.deepEqual(c.vacuous, ['financial-aid', 'staff-internal']);
    assert.equal(c.whollyVacuous, true);
  });

  test('ingesting one document into an empty namespace flips it to enforced', () => {
    // The remedy, asserted: this is what the harness should report once a real
    // financial-aid document exists.
    const c = assessExclusionCoverage(
      ['admissions', 'programmes', 'general'],
      UNIVERSE,
      { ...REAL_CENSUS, 'financial-aid': 8 },
    );
    assert.ok(c.enforced.includes('financial-aid'));
    assert.ok(!c.vacuous.includes('financial-aid'));
    assert.equal(c.vectorsWithheld, 20);
  });
});

describe('assessExclusionCoverage — boundaries', () => {
  test('a namespace missing from the census counts as empty, not as absent', () => {
    // Pinecone omits empty namespaces from describeIndexStats entirely, so
    // "no key" and "zero vectors" must mean the same thing here. Treating a
    // missing key as unknown would hide exactly the case being detected.
    const c = assessExclusionCoverage(['general'], ['general', 'staff-internal'], { general: 10 });
    assert.deepEqual(c.vacuous, ['staff-internal']);
  });

  test('an explicit zero is treated as empty', () => {
    const c = assessExclusionCoverage(
      ['general'],
      ['general', 'staff-internal'],
      { general: 10, 'staff-internal': 0 },
    );
    assert.deepEqual(c.vacuous, ['staff-internal']);
  });

  test('an unrestricted caller is not reported as vacuous', () => {
    // Nothing was excluded, so no exclusion failed to be tested. That is a
    // different situation from an exclusion that could not bite.
    const c = assessExclusionCoverage(['general', 'admissions'], ['general', 'admissions'], REAL_CENSUS);
    assert.equal(c.whollyVacuous, false);
    assert.deepEqual(c.enforced, []);
    assert.deepEqual(c.vacuous, []);
  });

  test('an empty index makes every exclusion vacuous', () => {
    const c = assessExclusionCoverage(['general'], UNIVERSE, {});
    assert.equal(c.whollyVacuous, true);
    assert.equal(c.vectorsWithheld, 0);
    assert.equal(c.enforced.length, 0);
  });
});

describe('knownNamespaces', () => {
  test('unions the gate tables and de-duplicates', () => {
    const ns = knownNamespaces(
      { student: ['general', 'admissions'], staff: ['general', 'staff-internal'] },
      { 1: ['general'], 3: ['academic-policy', 'financial-aid'] },
    );
    assert.deepEqual(ns, [
      'academic-policy', 'admissions', 'financial-aid', 'general', 'staff-internal',
    ]);
  });

  test('extra namespaces are folded in', () => {
    const ns = knownNamespaces({ student: ['general'] }, { 1: ['general'] }, ['platform-help']);
    assert.deepEqual(ns, ['general', 'platform-help']);
  });

  test('the universe comes from the gate, not the index', () => {
    // A namespace the security model defines but the corpus has never been
    // given is precisely the case worth flagging. Deriving the universe from
    // the index would make it invisible by construction.
    const ns = knownNamespaces({ staff: ['staff-internal'] }, { 4: ['staff-internal'] });
    assert.deepEqual(ns, ['staff-internal']);
    const c = assessExclusionCoverage([], ns, {});
    assert.deepEqual(c.vacuous, ['staff-internal']);
  });
});

describe('formatExclusionCoverage', () => {
  test('reports enforced exclusions with the volume behind them', () => {
    const line = formatExclusionCoverage(
      assessExclusionCoverage(['general'], ['general', 'academic-policy'], REAL_CENSUS),
    );
    assert.match(line, /withholds 12 vector\(s\) across \[academic-policy\]/);
  });

  test('names the vacuous namespaces loudly', () => {
    const line = formatExclusionCoverage(
      assessExclusionCoverage(['general'], ['general', 'staff-internal'], REAL_CENSUS),
    );
    assert.match(line, /VACUOUS for \[staff-internal\] — empty, cannot leak/);
  });

  test('says so plainly when no restriction applies', () => {
    const line = formatExclusionCoverage(assessExclusionCoverage(['general'], ['general'], REAL_CENSUS));
    assert.match(line, /no namespace restrictions apply/);
  });
});
