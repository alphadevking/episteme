// episteme-core/src/mastra/security/record-gate.test.ts
/**
 * Tests for the record access gate.
 *
 * Records are rows in a multi-tenant schema, so the failure modes here are
 * cross-tenant reads and cross-user reads — both invisible in a response that
 * looks perfectly well-formed. These assert the invariants directly rather than
 * through a tool, and run with no database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRecordScope,
  resolveRecordScopes,
  describeScope,
  RECORD_COLLECTIONS,
  type RecordSession,
  type RecordScope,
} from './record-gate';

const INST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER    = '11111111-1111-4111-8111-111111111111';
const OTHER   = '22222222-2222-4222-8222-222222222222';
const DEPT    = '33333333-3333-4333-8333-333333333333';

const ALL_ROLES = ['prospective', 'student', 'parent', 'staff', 'hod'];

const session = (over: Partial<RecordSession> = {}): RecordSession => ({
  roles: ['student'],
  trustLevel: 3,
  institutionId: INST_A,
  userPublicId: USER,
  ...over,
});

describe('tenant isolation is unconditional', () => {
  test('every scope carries the caller\'s institution', () => {
    for (const roles of [['prospective'], ['student'], ['staff'], ['hod'], ['parent']]) {
      for (const trustLevel of [1, 2, 3, 4]) {
        for (const isPlatformAdmin of [false, true]) {
          const scopes = resolveRecordScopes(
            session({ roles, trustLevel, isPlatformAdmin, departmentId: DEPT }),
          );
          for (const s of scopes) {
            assert.equal(s.institutionId, INST_A,
              `${roles}/${trustLevel}: scope ${s.collection} escaped the tenant`);
          }
        }
      }
    }
  });

  test('another tenant\'s id never appears in any scope', () => {
    const scopes = resolveRecordScopes(session({ roles: ['hod'], trustLevel: 4, departmentId: DEPT }));
    for (const s of scopes) assert.notEqual(s.institutionId, INST_B);
  });

  test('no institution means no records at all — there is no global tier', () => {
    // Deliberately unlike retrieval, which falls back to GLOBAL_INSTITUTION.
    // Every row in this schema belongs to exactly one tenant.
    for (const roles of [['prospective'], ['student'], ['staff'], ['hod']]) {
      for (const isPlatformAdmin of [false, true]) {
        assert.deepEqual(
          resolveRecordScopes({ roles, trustLevel: 4, isPlatformAdmin, userPublicId: USER }),
          [],
          `${roles} read records with no institution`,
        );
      }
    }
  });
});

describe('catalogue and calendar — the institution\'s public structure', () => {
  test('readable by every role at every trust level, including trust 1', () => {
    for (const role of [...ALL_ROLES, 'unknown', '']) {
      for (const trustLevel of [1, 2, 3, 4]) {
        for (const collection of ['catalogue', 'calendar'] as const) {
          assert.ok(
            resolveRecordScope(session({ roles: [role], trustLevel }), collection),
            `${role}/${trustLevel} could not read ${collection}`,
          );
        }
      }
    }
  });

  test('readable without a user id — nothing about them is caller-specific', () => {
    const s = resolveRecordScope(session({ userPublicId: undefined }), 'catalogue');
    assert.deepEqual(s, { collection: 'catalogue', institutionId: INST_A });
  });
});

describe('claims — scope narrows correctly by role', () => {
  test('a platform admin at trust 4 reads the whole institution', () => {
    const s = resolveRecordScope(session({ roles: ['staff'], trustLevel: 4, isPlatformAdmin: true }), 'claims');
    assert.deepEqual(s, { collection: 'claims', institutionId: INST_A, scope: 'institution' });
  });

  test('a HOD at trust 4 reads their own department only', () => {
    const s = resolveRecordScope(session({ roles: ['hod'], trustLevel: 4, departmentId: DEPT }), 'claims');
    assert.deepEqual(s, {
      collection: 'claims', institutionId: INST_A, scope: 'department', departmentId: DEPT,
    });
  });

  test('a staff member reads only what is assigned to them', () => {
    const s = resolveRecordScope(session({ roles: ['staff'], trustLevel: 4 }), 'claims');
    assert.deepEqual(s, { collection: 'claims', institutionId: INST_A, scope: 'assigned', userId: USER });
  });

  test('a student reads only their own submissions', () => {
    const s = resolveRecordScope(session({ roles: ['student'], trustLevel: 3 }), 'claims');
    assert.deepEqual(s, { collection: 'claims', institutionId: INST_A, scope: 'own', userId: USER });
  });

  test('a HOD with no department degrades to assigned, never to department-wide', () => {
    // A missing departmentId must not produce an unfiltered department query.
    const s = resolveRecordScope(session({ roles: ['hod'], trustLevel: 4 }), 'claims');
    assert.deepEqual(s, { collection: 'claims', institutionId: INST_A, scope: 'assigned', userId: USER });
  });

  test('institution-wide needs BOTH the platform bit and trust 4', () => {
    for (const [trustLevel, isPlatformAdmin] of [[3, true], [4, false], [1, true]] as const) {
      const s = resolveRecordScope(session({ roles: ['staff'], trustLevel, isPlatformAdmin }), 'claims');
      assert.notEqual(
        s && 'scope' in s ? s.scope : null, 'institution',
        `trust=${trustLevel} bit=${isPlatformAdmin} granted institution-wide claims`,
      );
    }
  });

  test('a reviewer role below trust 4 falls back to own', () => {
    for (const role of ['staff', 'hod']) {
      for (const trustLevel of [1, 2, 3]) {
        const s = resolveRecordScope(session({ roles: [role], trustLevel, departmentId: DEPT }), 'claims');
        assert.deepEqual(
          s, { collection: 'claims', institutionId: INST_A, scope: 'own', userId: USER },
          `${role}/${trustLevel} exceeded own scope`,
        );
      }
    }
  });

  test('with no user id there is no claim scope at all', () => {
    // "own" needs someone to be. Returning an unscoped query here would expose
    // every claim in the tenant.
    assert.equal(
      resolveRecordScope(session({ roles: ['student'], userPublicId: undefined }), 'claims'),
      null,
    );
  });

  test('a self-scoped claim query always binds the caller, never another user', () => {
    const s = resolveRecordScope(session({ roles: ['student'] }), 'claims');
    assert.ok(s && 'userId' in s);
    assert.equal(s.userId, USER);
    assert.notEqual(s.userId, OTHER);
  });
});

describe('claims — multi-role access is a union, not a ranking', () => {
  test('an admin who is also a student still gets the widest scope', () => {
    const s = resolveRecordScope(
      session({ roles: ['student', 'staff'], trustLevel: 4, isPlatformAdmin: true }), 'claims',
    );
    assert.deepEqual(s, { collection: 'claims', institutionId: INST_A, scope: 'institution' });
  });

  test('a student who is also a HOD reads their department', () => {
    const s = resolveRecordScope(
      session({ roles: ['student', 'hod'], trustLevel: 4, departmentId: DEPT }), 'claims',
    );
    assert.ok(s && 'scope' in s && s.scope === 'department');
  });

  test('adding a role never narrows the claim scope', () => {
    const widthOf = (s: RecordScope | null) =>
      s && 'scope' in s ? ['own', 'assigned', 'department', 'institution'].indexOf(s.scope) : -1;

    for (const base of ALL_ROLES) {
      const alone = widthOf(resolveRecordScope(
        session({ roles: [base], trustLevel: 4, departmentId: DEPT }), 'claims'));
      for (const extra of ALL_ROLES) {
        const together = widthOf(resolveRecordScope(
          session({ roles: [base, extra], trustLevel: 4, departmentId: DEPT }), 'claims'));
        assert.ok(together >= alone, `adding ${extra} to ${base} narrowed claim scope`);
      }
    }
  });
});

describe('ownRecord — self and verified parent links', () => {
  test('binds to the caller when they have a user id', () => {
    const s = resolveRecordScope(session(), 'ownRecord');
    assert.deepEqual(s, { collection: 'ownRecord', institutionId: INST_A, subjectUserId: USER });
  });

  test('a parent with a verified permitted link reads the linked student', () => {
    const s = resolveRecordScope(
      session({ roles: ['parent'], userPublicId: undefined, linkedStudentUserId: OTHER }), 'ownRecord',
    );
    assert.deepEqual(s, { collection: 'ownRecord', institutionId: INST_A, subjectUserId: OTHER });
  });

  test('a parent with no link reads nothing', () => {
    // The chat route only populates linkedStudentUserId for a verified link with
    // can_view_academic — its absence is the permission being withheld.
    assert.equal(
      resolveRecordScope(session({ roles: ['parent'], userPublicId: undefined }), 'ownRecord'),
      null,
    );
  });

  test('a parent who is also a student sees their OWN record by default', () => {
    const s = resolveRecordScope(
      session({ roles: ['parent', 'student'], linkedStudentUserId: OTHER }), 'ownRecord',
    );
    assert.ok(s && 'subjectUserId' in s);
    assert.equal(s.subjectUserId, USER, 'resolved to the linked student rather than the caller');
  });
});

describe('fails closed on unknown input', () => {
  test('an unknown role gets the public tier only — never claims beyond its own', () => {
    const scopes = resolveRecordScopes(session({ roles: ['root', 'admin', 'superadmin'], trustLevel: 4 }));
    const claims = scopes.find((s) => s.collection === 'claims');
    assert.ok(claims && 'scope' in claims && claims.scope === 'own',
      `unknown roles resolved to ${claims && 'scope' in claims ? claims.scope : 'none'}`);
  });

  test('an empty role set does not throw and grants nothing beyond the public tier', () => {
    const scopes = resolveRecordScopes(session({ roles: [], trustLevel: 4 }));
    const collections = scopes.map((s) => s.collection);
    assert.ok(collections.includes('catalogue'));
    const claims = scopes.find((s) => s.collection === 'claims');
    assert.ok(claims && 'scope' in claims && claims.scope === 'own');
  });

  test('at most one scope per collection is ever returned', () => {
    // Two scopes for one collection would let a tool pick the wider one.
    for (const roles of [['student'], ['staff'], ['hod'], ['parent', 'student', 'staff']]) {
      const scopes = resolveRecordScopes(
        session({ roles, trustLevel: 4, departmentId: DEPT, isPlatformAdmin: true, linkedStudentUserId: OTHER }),
      );
      const seen = scopes.map((s) => s.collection);
      assert.equal(new Set(seen).size, seen.length, `duplicate collection for ${roles}`);
    }
  });

  test('every collection name resolves or returns null — never undefined', () => {
    for (const collection of RECORD_COLLECTIONS) {
      const result = resolveRecordScope(session({ userPublicId: undefined }), collection);
      assert.ok(result === null || result.collection === collection);
    }
  });
});

describe('describeScope — provenance labels leak no identifiers', () => {
  test('no label contains a UUID', () => {
    const scopes = resolveRecordScopes(
      session({ roles: ['hod'], trustLevel: 4, departmentId: DEPT, linkedStudentUserId: OTHER }),
    );
    for (const s of scopes) {
      const label = describeScope(s);
      for (const id of [INST_A, USER, OTHER, DEPT]) {
        assert.ok(!label.includes(id), `label "${label}" leaked an identifier`);
      }
      assert.ok(label.length > 0);
    }
  });

  test('each claim scope has a distinct label', () => {
    const labels = (['institution', 'department', 'assigned', 'own'] as const).map((scope) =>
      describeScope(
        scope === 'department'
          ? { collection: 'claims', institutionId: INST_A, scope, departmentId: DEPT }
          : scope === 'institution'
            ? { collection: 'claims', institutionId: INST_A, scope }
            : { collection: 'claims', institutionId: INST_A, scope, userId: USER },
      ),
    );
    assert.equal(new Set(labels).size, labels.length, `labels collide: ${labels.join(' | ')}`);
  });
});
