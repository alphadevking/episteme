// lib/session-derivation.test.ts
/**
 * Tests for the chat route's role + trust derivation — the values forwarded to
 * episteme-core as trusted headers. These assert the escalation the audit found
 * is closed: neither role nor trust can be raised from user-controlled input.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEffectiveRole,
  deriveTrustLevel,
  RETRIEVAL_ROLE,
  ROLE_PRIORITY,
} from './session-derivation';

describe('resolveEffectiveRole', () => {
  test('picks the most privileged role from primary + roles array', () => {
    assert.equal(resolveEffectiveRole('student', ['student', 'hod']), 'hod');
    assert.equal(resolveEffectiveRole('staff', ['staff', 'admin']), 'admin');
    assert.equal(resolveEffectiveRole('prospective', ['student']), 'student');
  });

  test('ignores prospective when any elevated role is present', () => {
    assert.equal(resolveEffectiveRole('prospective', ['prospective', 'staff']), 'staff');
  });

  test('falls back to prospective when nothing elevated exists', () => {
    assert.equal(resolveEffectiveRole('prospective', []), 'prospective');
    assert.equal(resolveEffectiveRole('prospective', ['prospective']), 'prospective');
    assert.equal(resolveEffectiveRole('', []), 'prospective');
  });

  test('unknown roles score 0 and never out-rank a real role', () => {
    assert.equal(resolveEffectiveRole('student', ['wizard', 'god', 'root']), 'student');
    // A junk primary with no real roles stays junk but does not crash; it is
    // the retrieval-role map (below) that neutralises unknowns into prospective.
    assert.equal(resolveEffectiveRole('wizard', []), 'wizard');
  });
});

describe('RETRIEVAL_ROLE mapping', () => {
  test('admin and superadmin map to staff (most privileged retrieval role)', () => {
    assert.equal(RETRIEVAL_ROLE.admin, 'staff');
    assert.equal(RETRIEVAL_ROLE.superadmin, 'staff');
  });

  test('unknown roles have no mapping, so the route falls back to prospective', () => {
    assert.equal(RETRIEVAL_ROLE.wizard, undefined);
    assert.equal(RETRIEVAL_ROLE.wizard ?? 'prospective', 'prospective');
  });
});

describe('deriveTrustLevel — elevated roles pinned to 4', () => {
  test('admins and superadmins are privileged (the original request)', () => {
    // Regression for the bug that admins landed on trust 1 (public-only)
    // because their aiCtx.trust_level defaulted to 1.
    for (const role of ['superadmin', 'admin', 'hod', 'staff']) {
      assert.equal(deriveTrustLevel(role, undefined), 4, `${role} should be trust 4`);
      assert.equal(deriveTrustLevel(role, 1), 4, `${role} stored=1 should still be 4`);
    }
  });

  test('an elevated role ignores whatever is stored', () => {
    // Their trust comes from the verified role, so the stored value is moot.
    assert.equal(deriveTrustLevel('admin', 0), 4);
    assert.equal(deriveTrustLevel('admin', 99), 4);
  });
});

describe('deriveTrustLevel — non-elevated roles capped at 3', () => {
  test('a self-set trust_level of 4 cannot take effect', () => {
    // The escalation vector: student writes trust_level=4 to their own
    // user_ai_context row. Capping to 3 neutralises it.
    assert.equal(deriveTrustLevel('student', 4), 3);
    assert.equal(deriveTrustLevel('student', 99), 3);
    assert.equal(deriveTrustLevel('parent', 4), 3);
    assert.equal(deriveTrustLevel('prospective', 4), 3);
  });

  test('legitimate stored trust passes through within range', () => {
    assert.equal(deriveTrustLevel('student', 2), 2); // self-reported matric
    assert.equal(deriveTrustLevel('student', 3), 3); // portal-verified
  });

  test('missing or junk stored trust falls back to 1, never higher', () => {
    for (const stored of [undefined, null, NaN, 3.5, '3', '4', {}, [], true]) {
      assert.equal(deriveTrustLevel('student', stored), 1, `stored=${JSON.stringify(stored)} → 1`);
    }
  });

  test('values below the floor clamp to 1', () => {
    assert.equal(deriveTrustLevel('student', 0), 1);
    assert.equal(deriveTrustLevel('student', -5), 1);
  });

  test('no non-elevated role can ever reach trust 4 by any stored value', () => {
    for (const role of ['student', 'parent', 'guardian', 'prospective']) {
      for (const stored of [4, 5, 99, Infinity, '4', 4.0]) {
        assert.ok(deriveTrustLevel(role, stored) <= 3, `${role}/${String(stored)} reached ${deriveTrustLevel(role, stored)}`);
      }
    }
  });
});

describe('ROLE_PRIORITY ordering', () => {
  test('privilege ranks strictly increase from prospective to superadmin', () => {
    const order = ['prospective', 'parent', 'student', 'staff', 'hod', 'admin', 'superadmin'];
    for (let i = 1; i < order.length; i++) {
      assert.ok(
        ROLE_PRIORITY[order[i]] > ROLE_PRIORITY[order[i - 1]],
        `${order[i]} should outrank ${order[i - 1]}`,
      );
    }
  });
});
