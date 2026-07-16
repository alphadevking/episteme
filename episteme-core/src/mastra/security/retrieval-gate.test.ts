// episteme-core/src/mastra/security/retrieval-gate.test.ts
/**
 * Tests for the retrieval access gate.
 *
 * These assert the security invariants directly rather than through the agent.
 * The prompt evals cannot cover this: an injection eval passes when the model
 * merely refuses, which proves nothing about the gate. Here the gate is called
 * with a hostile session and the resulting namespace set is asserted.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveNamespaces,
  buildRetrievalFilter,
  ROLE_NAMESPACES,
  TRUST_NAMESPACES,
  GLOBAL_INSTITUTION,
} from './retrieval-gate';

const INSTITUTION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INSTITUTION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ALL_ROLES = Object.keys(ROLE_NAMESPACES);
const ALL_TRUST = Object.keys(TRUST_NAMESPACES).map(Number);

describe('resolveNamespaces — trust ceiling', () => {
  test('staff role at trust 1 cannot reach staff-internal', () => {
    // The escalation the prompt-injection eval was meant to cover: a caller
    // claiming an elevated role while the session says otherwise.
    const ns = resolveNamespaces({ role: 'staff', trustLevel: 1 });
    assert.ok(!ns.includes('staff-internal'), `leaked staff-internal: ${ns.join(',')}`);
    assert.ok(!ns.includes('academic-policy'));
    assert.ok(!ns.includes('financial-aid'));
    assert.deepEqual(ns, ['admissions', 'programmes', 'general']);
  });

  test('staff role at trust 4 does reach staff-internal', () => {
    // Confirms the previous test fails for the right reason — the gate is
    // closed at trust 1, not simply broken for staff everywhere.
    const ns = resolveNamespaces({ role: 'staff', trustLevel: 4 });
    assert.ok(ns.includes('staff-internal'));
  });

  test('staff-internal is reachable at trust 4 only, for every role', () => {
    for (const role of ALL_ROLES) {
      for (const trustLevel of ALL_TRUST) {
        const ns = resolveNamespaces({ role, trustLevel });
        if (ns.includes('staff-internal')) {
          assert.equal(trustLevel, 4, `${role} reached staff-internal at trust ${trustLevel}`);
          assert.ok(['staff', 'hod'].includes(role), `${role} reached staff-internal`);
        }
      }
    }
  });

  test('student at trust 2 cannot reach academic-policy or financial-aid', () => {
    const ns = resolveNamespaces({ role: 'student', trustLevel: 2 });
    assert.ok(!ns.includes('academic-policy'));
    assert.ok(!ns.includes('financial-aid'));
  });

  test('student at trust 3 reaches academic-policy and financial-aid', () => {
    const ns = resolveNamespaces({ role: 'student', trustLevel: 3 });
    assert.ok(ns.includes('academic-policy'));
    assert.ok(ns.includes('financial-aid'));
  });

  test('raising trust never removes access; lowering never adds it', () => {
    for (const role of ALL_ROLES) {
      for (let t = 2; t <= 4; t++) {
        const lower = new Set(resolveNamespaces({ role, trustLevel: t - 1 }));
        const higher = resolveNamespaces({ role, trustLevel: t });
        for (const ns of lower) {
          assert.ok(higher.includes(ns), `${role}: trust ${t} lost "${ns}" vs trust ${t - 1}`);
        }
      }
    }
  });

  test('result is always a subset of both the role and trust ceilings', () => {
    for (const role of ALL_ROLES) {
      for (const trustLevel of ALL_TRUST) {
        const ns = resolveNamespaces({ role, trustLevel });
        for (const n of ns) {
          assert.ok(ROLE_NAMESPACES[role].includes(n), `${role}/${trustLevel}: "${n}" exceeds role`);
          assert.ok(TRUST_NAMESPACES[trustLevel].includes(n), `${role}/${trustLevel}: "${n}" exceeds trust`);
        }
      }
    }
  });
});

describe('resolveNamespaces — fails closed on bad input', () => {
  test('trust level defaults to public-only when omitted', () => {
    assert.deepEqual(resolveNamespaces({ role: 'staff' }), ['admissions', 'programmes', 'general']);
  });

  test('unknown role degrades to prospective, never to a wider set', () => {
    for (const role of ['admin', 'superadmin', 'root', '', 'STAFF', 'staff ']) {
      const ns = resolveNamespaces({ role, trustLevel: 4 });
      assert.deepEqual(ns, ROLE_NAMESPACES['prospective'], `role "${role}" resolved to ${ns.join(',')}`);
      assert.ok(!ns.includes('staff-internal'));
    }
  });

  test('out-of-range trust levels degrade to public-only', () => {
    for (const trustLevel of [0, 5, 99, -1, 1.5, NaN, Infinity]) {
      const ns = resolveNamespaces({ role: 'staff', trustLevel });
      assert.deepEqual(ns, ['admissions', 'programmes', 'general'], `trust ${trustLevel} leaked ${ns.join(',')}`);
    }
  });
});

describe('resolveNamespaces — allowlist can only narrow', () => {
  test('parent allowlist without fee permission excludes financial-aid', () => {
    const ns = resolveNamespaces({
      role: 'parent',
      trustLevel: 4,
      namespaceAllowlist: ['admissions', 'general'],
    });
    assert.deepEqual(ns, ['admissions', 'general']);
    assert.ok(!ns.includes('financial-aid'));
  });

  test('allowlist cannot grant a namespace the gate already denied', () => {
    // A parent link cannot hand out staff-internal even if the allowlist says so.
    const ns = resolveNamespaces({
      role: 'parent',
      trustLevel: 4,
      namespaceAllowlist: ['staff-internal', 'admissions'],
    });
    assert.ok(!ns.includes('staff-internal'));
    assert.deepEqual(ns, ['admissions']);
  });

  test('allowlist result is always a subset of the un-allowlisted result', () => {
    const allowlist = ['financial-aid', 'general', 'staff-internal'];
    for (const role of ALL_ROLES) {
      for (const trustLevel of ALL_TRUST) {
        const base = resolveNamespaces({ role, trustLevel });
        const narrowed = resolveNamespaces({ role, trustLevel, namespaceAllowlist: allowlist });
        for (const n of narrowed) {
          assert.ok(base.includes(n), `${role}/${trustLevel}: allowlist widened access to "${n}"`);
        }
      }
    }
  });

  test('empty allowlist is treated as "not supplied" (documented behaviour)', () => {
    // Callers must omit the allowlist rather than pass []. getSessionContext
    // already normalises an empty list to undefined, so this path should not
    // arise in production — asserted here so a change in that contract is loud.
    const ns = resolveNamespaces({ role: 'parent', trustLevel: 4, namespaceAllowlist: [] });
    assert.deepEqual(ns, resolveNamespaces({ role: 'parent', trustLevel: 4 }));
  });
});

describe('buildRetrievalFilter — tenant isolation', () => {
  const institutionClause = (f: ReturnType<typeof buildRetrievalFilter>) =>
    f.$and.find((c) => 'institutionId' in c) as
      | { institutionId: { $in: string[] } }
      | undefined;

  test("a caller's filter never admits another tenant's id", () => {
    const filter = buildRetrievalFilter({ role: 'staff', institutionId: INSTITUTION_A });
    const ids = institutionClause(filter)!.institutionId.$in;
    assert.ok(!ids.includes(INSTITUTION_B));
    assert.deepEqual(ids, [INSTITUTION_A, GLOBAL_INSTITUTION]);
  });

  test('institution clause is present on every query shape', () => {
    const shapes = [
      { role: 'student' },
      { role: 'student', programme: 'Computer Science' },
      { role: 'student', level: '300L' },
      { role: 'student', programme: 'Computer Science', level: '300L', institutionId: INSTITUTION_A },
    ];
    for (const shape of shapes) {
      const clause = institutionClause(buildRetrievalFilter(shape));
      assert.ok(clause, `no institution clause for ${JSON.stringify(shape)}`);
      assert.ok(clause.institutionId.$in.includes(GLOBAL_INSTITUTION));
    }
  });

  test('omitting institutionId narrows to shared docs — never a wildcard', () => {
    const ids = institutionClause(buildRetrievalFilter({ role: 'staff' }))!.institutionId.$in;
    assert.deepEqual(ids, [GLOBAL_INSTITUTION, GLOBAL_INSTITUTION]);
    assert.ok(!ids.some((id) => id === '*' || id === undefined || id === null));
  });

  test('role is always constrained in the filter', () => {
    const filter = buildRetrievalFilter({ role: 'prospective', institutionId: INSTITUTION_A });
    const roleClause = filter.$and.find((c) => 'roles' in c) as { roles: { $in: string[] } };
    assert.deepEqual(roleClause.roles.$in, ['prospective']);
  });

  test('programme and level clauses appear only when scoped', () => {
    const bare = buildRetrievalFilter({ role: 'student' });
    assert.equal(bare.$and.length, 2); // roles + institution

    const scoped = buildRetrievalFilter({ role: 'student', programme: 'CS', level: '300L' });
    assert.equal(scoped.$and.length, 4); // roles + programme + level + institution
  });
});
