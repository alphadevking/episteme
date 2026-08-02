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
  resolveNamespacesForRoles,
  resolvePlatformNamespaces,
  buildRetrievalFilter,
  expandAudienceRoles,
  grantsSeniorAudience,
  ROLE_NAMESPACES,
  TRUST_NAMESPACES,
  GLOBAL_INSTITUTION,
  PLATFORM_HELP_NAMESPACE,
  PLATFORM_ADMIN_NAMESPACE,
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

describe('resolveNamespacesForRoles — single-role equivalence', () => {
  const ALLOWLISTS = [
    undefined,
    ['admissions', 'general'],
    ['admissions', 'general', 'financial-aid'],
    ['staff-internal'],
    [],
  ];

  test('a one-element role set is byte-identical to the scalar form', () => {
    // THE regression guard for the multi-role change. Every existing user holds
    // exactly one role; if this holds, none of them can move.
    for (const role of [...ALL_ROLES, 'admin', 'unknown', '']) {
      for (const trustLevel of [...ALL_TRUST, 0, 99, NaN]) {
        for (const namespaceAllowlist of ALLOWLISTS) {
          assert.deepEqual(
            resolveNamespacesForRoles({ roles: [role], trustLevel, namespaceAllowlist }),
            resolveNamespaces({ role, trustLevel, namespaceAllowlist }),
            `diverged for role=${role} trust=${trustLevel} allowlist=${JSON.stringify(namespaceAllowlist)}`,
          );
        }
      }
    }
  });
});

describe('resolveNamespacesForRoles — union semantics', () => {
  test('union never exceeds the trust ceiling, for every role combination', () => {
    // The security invariant that makes unioning safe: trust is applied per
    // role, so no combination can reach past it.
    for (const a of ALL_ROLES) {
      for (const b of ALL_ROLES) {
        for (const trustLevel of ALL_TRUST) {
          const ns = resolveNamespacesForRoles({ roles: [a, b], trustLevel });
          for (const n of ns) {
            assert.ok(
              TRUST_NAMESPACES[trustLevel].includes(n),
              `[${a},${b}]/${trustLevel}: "${n}" exceeds trust ceiling`,
            );
          }
        }
      }
    }
  });

  test('union contains each role\'s own namespaces — access is never lost', () => {
    // The live bug this fixes: {student, admin} collapsed to 'staff' and lost
    // every student-tagged document.
    for (const a of ALL_ROLES) {
      for (const b of ALL_ROLES) {
        const union = resolveNamespacesForRoles({ roles: [a, b], trustLevel: 4 });
        for (const role of [a, b]) {
          for (const n of resolveNamespaces({ role, trustLevel: 4 })) {
            assert.ok(union.includes(n), `[${a},${b}]: union lost "${n}" from ${role}`);
          }
        }
      }
    }
  });

  test('adding a role never removes a namespace', () => {
    for (const a of ALL_ROLES) {
      const alone = resolveNamespacesForRoles({ roles: [a], trustLevel: 4 });
      for (const b of ALL_ROLES) {
        const together = resolveNamespacesForRoles({ roles: [a, b], trustLevel: 4 });
        for (const n of alone) {
          assert.ok(together.includes(n), `adding ${b} to ${a} removed "${n}"`);
        }
      }
    }
  });

  test('staff-internal still requires trust 4 and a staff-family role', () => {
    for (const a of ALL_ROLES) {
      for (const b of ALL_ROLES) {
        for (const trustLevel of ALL_TRUST) {
          const ns = resolveNamespacesForRoles({ roles: [a, b], trustLevel });
          if (ns.includes('staff-internal')) {
            assert.equal(trustLevel, 4, `[${a},${b}] reached staff-internal at trust ${trustLevel}`);
            assert.ok(
              [a, b].some((r) => ['staff', 'hod'].includes(r)),
              `[${a},${b}] reached staff-internal with no staff-family role`,
            );
          }
        }
      }
    }
  });

  test('an empty or all-unknown role set is the public tier', () => {
    const publicTier = resolveNamespaces({ role: 'prospective', trustLevel: 4 });
    assert.deepEqual(resolveNamespacesForRoles({ roles: [], trustLevel: 4 }), publicTier);
    assert.deepEqual(
      resolveNamespacesForRoles({ roles: ['root', 'admin'], trustLevel: 4 }),
      publicTier,
    );
  });

  test('the result never contains duplicates', () => {
    for (const trustLevel of ALL_TRUST) {
      const ns = resolveNamespacesForRoles({ roles: [...ALL_ROLES, ...ALL_ROLES], trustLevel });
      assert.equal(new Set(ns).size, ns.length, `duplicates: ${ns.join(',')}`);
    }
  });
});

describe('resolveNamespacesForRoles — parent allowlist scoping', () => {
  test('a pure parent is still narrowed by the allowlist', () => {
    const ns = resolveNamespacesForRoles({
      roles: ['parent'],
      trustLevel: 4,
      namespaceAllowlist: ['admissions', 'general'],
    });
    assert.deepEqual(ns, ['admissions', 'general']);
  });

  test("a parent who is also a student keeps their OWN student access", () => {
    // The edge case naive unioning gets wrong: the link allowlist limits what a
    // parent may see about their CHILD, and must not clip the same person's
    // access to their own records.
    const ns = resolveNamespacesForRoles({
      roles: ['parent', 'student'],
      trustLevel: 3,
      namespaceAllowlist: ['admissions', 'general'],
    });
    assert.ok(ns.includes('academic-policy'), 'lost own student academic access');
    assert.ok(ns.includes('financial-aid'), 'lost own student fee access');
  });

  test('the allowlist still cannot grant what the gate denies', () => {
    const ns = resolveNamespacesForRoles({
      roles: ['parent', 'student'],
      trustLevel: 3,
      namespaceAllowlist: ['staff-internal'],
    });
    assert.ok(!ns.includes('staff-internal'));
  });

  test('with no parent role, an allowlist narrows the whole union (fails closed)', () => {
    const ns = resolveNamespacesForRoles({
      roles: ['staff'],
      trustLevel: 4,
      namespaceAllowlist: ['general'],
    });
    assert.deepEqual(ns, ['general']);
  });
});

describe('resolvePlatformNamespaces', () => {
  test('platform-help is available at every trust level, including public', () => {
    for (const trustLevel of ALL_TRUST) {
      assert.ok(
        resolvePlatformNamespaces({ trustLevel }).includes(PLATFORM_HELP_NAMESPACE),
        `platform-help missing at trust ${trustLevel}`,
      );
    }
  });

  test('platform-admin requires BOTH the platform-admin bit and trust 4', () => {
    for (const trustLevel of ALL_TRUST) {
      for (const isPlatformAdmin of [true, false]) {
        const ns = resolvePlatformNamespaces({ trustLevel, isPlatformAdmin });
        if (ns.includes(PLATFORM_ADMIN_NAMESPACE)) {
          assert.equal(trustLevel, 4);
          assert.equal(isPlatformAdmin, true);
        }
      }
    }
  });

  test('the bit alone is not enough, and trust 4 alone is not enough', () => {
    assert.ok(!resolvePlatformNamespaces({ trustLevel: 3, isPlatformAdmin: true })
      .includes(PLATFORM_ADMIN_NAMESPACE));
    assert.ok(!resolvePlatformNamespaces({ trustLevel: 4, isPlatformAdmin: false })
      .includes(PLATFORM_ADMIN_NAMESPACE));
    assert.ok(resolvePlatformNamespaces({ trustLevel: 4, isPlatformAdmin: true })
      .includes(PLATFORM_ADMIN_NAMESPACE));
  });

  test('defaults deny the admin namespace', () => {
    assert.deepEqual(resolvePlatformNamespaces({}), [PLATFORM_HELP_NAMESPACE]);
  });
});

describe('the two gates stay independent', () => {
  test('platform namespaces are never returned by the institutional gate', () => {
    // They are not Pinecone partitions — the platform tier reads Markdown from
    // disk. Leaking one into this list would query a permanently empty
    // partition on every request.
    for (const role of [...ALL_ROLES, 'admin', 'unknown']) {
      for (const trustLevel of ALL_TRUST) {
        const ns = resolveNamespacesForRoles({ roles: [role], trustLevel });
        assert.ok(!ns.includes(PLATFORM_HELP_NAMESPACE), `${role}/${trustLevel} leaked platform-help`);
        assert.ok(!ns.includes(PLATFORM_ADMIN_NAMESPACE), `${role}/${trustLevel} leaked platform-admin`);
      }
    }
  });

  test('a parent allowlist cannot strip platform-help', () => {
    // The reason platform access is resolved on its own axis: a restrictive
    // parent link must not remove the ability to ask how to use the product.
    const ns = resolvePlatformNamespaces({ trustLevel: 1 });
    assert.deepEqual(ns, [PLATFORM_HELP_NAMESPACE]);
  });

  test('the platform bit never widens institutional access', () => {
    for (const trustLevel of ALL_TRUST) {
      for (const role of ALL_ROLES) {
        // isPlatformAdmin is not even a parameter of the institutional gate —
        // asserted structurally so a future refactor cannot quietly add it.
        assert.deepEqual(
          resolveNamespacesForRoles({ roles: [role], trustLevel }),
          resolveNamespaces({ role, trustLevel }),
          `institutional access diverged for ${role}/${trustLevel}`,
        );
      }
    }
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

  /**
   * Updated when audience progression landed. The original asserted the clause
   * was exactly ['student', 'staff']; it is now that set plus the audiences
   * those roles subsume. The INTENT — a role array matches documents tagged for
   * any of the caller's roles — is unchanged and still asserted first; the
   * exact set is pinned after it so progression cannot quietly widen further.
   */
  test('a role array matches documents tagged for any of them, plus subsumed audiences', () => {
    const filter = buildRetrievalFilter({ role: ['student', 'staff'] });
    const roleClause = filter.$and.find((c) => 'roles' in c) as { roles: { $in: string[] } };

    for (const own of ['student', 'staff']) {
      assert.ok(roleClause.roles.$in.includes(own), `caller's own role ${own} must match`);
    }
    assert.deepEqual(
      new Set(roleClause.roles.$in),
      new Set(['student', 'staff', 'parent', 'prospective']),
    );
    assert.equal(roleClause.roles.$in.includes('hod'), false, 'must not reach a senior audience');
  });

  test('a one-element array is identical to the scalar form', () => {
    for (const role of ALL_ROLES) {
      assert.deepEqual(
        buildRetrievalFilter({ role: [role], institutionId: INSTITUTION_A }),
        buildRetrievalFilter({ role, institutionId: INSTITUTION_A }),
        `array form diverged for ${role}`,
      );
    }
  });

  test('a role array does not change the clause count', () => {
    // Guards against the array form accidentally emitting one clause per role,
    // which would turn the OR into an AND and match nothing.
    const filter = buildRetrievalFilter({ role: ['student', 'staff', 'hod'] });
    assert.equal(filter.$and.length, 2); // roles + institution
  });

  test('programme and level clauses appear only when scoped', () => {
    const bare = buildRetrievalFilter({ role: 'student' });
    assert.equal(bare.$and.length, 2); // roles + institution

    const scoped = buildRetrievalFilter({ role: 'student', programme: 'CS', level: '300L' });
    assert.equal(scoped.$and.length, 4); // roles + programme + level + institution
  });
});

describe('expandAudienceRoles — audience progression', () => {
  /**
   * The bug this exists to fix, found by the retrieval eval against the real
   * corpus: admissions documents are tagged [prospective, student, parent,
   * staff], so a caller holding only 'hod' matched none of them. The most
   * senior role retrieved less than a prospective applicant.
   */
  test('a HOD reads every audience below them', () => {
    const expanded = expandAudienceRoles(['hod']);
    for (const audience of ['hod', 'staff', 'student', 'parent', 'prospective']) {
      assert.ok(expanded.includes(audience), `hod should read ${audience}-tagged documents`);
    }
  });

  test('staff read student, parent and prospective audiences', () => {
    const expanded = expandAudienceRoles(['staff']);
    assert.deepEqual(new Set(expanded), new Set(['staff', 'student', 'parent', 'prospective']));
  });

  /**
   * THE security property. Expansion is downward only: it may add less
   * privileged audiences, never a more privileged one. If this ever fails,
   * a student can read staff-authored documents.
   */
  test('expansion never grants a senior audience the caller does not hold', () => {
    const everyCombination: string[][] = [
      ['prospective'], ['student'], ['parent'], ['staff'], ['hod'],
      ['student', 'parent'], ['prospective', 'student'], ['parent', 'student'],
      ['staff', 'student'], ['hod', 'student'], ['unknown-role'], [],
    ];
    for (const roles of everyCombination) {
      assert.equal(
        grantsSeniorAudience(roles), false,
        `expandAudienceRoles(${JSON.stringify(roles)}) leaked a senior audience: ` +
        JSON.stringify(expandAudienceRoles(roles)),
      );
    }
  });

  test('non-staff roles never gain staff or hod audiences', () => {
    for (const role of ['prospective', 'student', 'parent']) {
      const expanded = expandAudienceRoles([role]);
      assert.equal(expanded.includes('staff'), false, `${role} must not read staff-tagged documents`);
      assert.equal(expanded.includes('hod'), false, `${role} must not read hod-tagged documents`);
    }
  });

  test('an unknown role contributes only itself — fails closed', () => {
    assert.deepEqual(expandAudienceRoles(['not-a-role']), ['not-a-role']);
  });

  test('expansion is idempotent and never shrinks the caller\'s own roles', () => {
    for (const roles of [['hod'], ['staff', 'student'], ['parent'], ['prospective']]) {
      const once  = expandAudienceRoles(roles);
      const twice = expandAudienceRoles(once);
      assert.deepEqual(new Set(twice), new Set(once));
      for (const role of roles) assert.ok(once.includes(role), 'own role must survive expansion');
    }
  });

  test('the result never contains duplicates', () => {
    const expanded = expandAudienceRoles(['hod', 'staff', 'student', 'student']);
    assert.equal(expanded.length, new Set(expanded).size);
  });
});

describe('buildRetrievalFilter — audience progression', () => {
  const rolesClause = (f: ReturnType<typeof buildRetrievalFilter>) =>
    f.$and.find((c) => 'roles' in c) as { roles: { $in: string[] } };

  test('a HOD filter matches student- and prospective-tagged documents', () => {
    const clause = rolesClause(buildRetrievalFilter({ role: 'hod' }));
    for (const audience of ['hod', 'staff', 'student', 'prospective']) {
      assert.ok(clause.roles.$in.includes(audience));
    }
  });

  test('a student filter still cannot match staff-tagged documents', () => {
    const clause = rolesClause(buildRetrievalFilter({ role: 'student' }));
    assert.equal(clause.roles.$in.includes('staff'), false);
    assert.equal(clause.roles.$in.includes('hod'), false);
  });

  /**
   * Progression changes the audience filter ONLY. Namespaces and the trust
   * ceiling remain the confidentiality control, so a claimed staff role at low
   * trust gains nothing from this change.
   */
  test('progression does not widen namespaces', () => {
    assert.deepEqual(
      resolveNamespaces({ role: 'staff', trustLevel: 1 }),
      resolveNamespaces({ role: 'staff', trustLevel: 1 }),
    );
    assert.equal(resolveNamespaces({ role: 'hod', trustLevel: 1 }).includes('staff-internal'), false);
  });
});
