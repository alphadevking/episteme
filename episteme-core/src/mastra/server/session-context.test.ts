// episteme-core/src/mastra/server/session-context.test.ts
/**
 * Tests for the trusted session context.
 *
 * This is the boundary itself: values arrive as request headers from the
 * authenticated chat proxy and are read here by the tools. Everything must
 * degrade to the public tier rather than upward, because a bad value must
 * never become an escalation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RequestContext } from '@mastra/core/request-context';
import {
  getSessionContext,
  clampTrustLevel,
  normalizeSessionRole,
  SESSION_KEYS,
} from './session-context';

function contextWith(entries: Record<string, unknown>): RequestContext {
  const rc = new RequestContext();
  for (const [k, v] of Object.entries(entries)) rc.set(k, v);
  return rc;
}

describe('clampTrustLevel', () => {
  test('clamps finite values above the ceiling to 4', () => {
    for (const raw of [5, 99, 1000]) {
      assert.equal(clampTrustLevel(raw), 4, `${raw} should clamp to 4`);
    }
  });

  test('clamps below the floor to 1', () => {
    for (const raw of [0, -1, -99, -Infinity]) {
      assert.equal(clampTrustLevel(raw), 1, `${raw} should clamp to 1`);
    }
  });

  test('non-integers and junk fall back to 1, never higher', () => {
    // Infinity is here rather than with the clamping cases on purpose: an
    // unbounded value is junk, so it fails closed to 1 instead of saturating
    // to the maximum tier.
    for (const raw of [undefined, null, '', 'four', {}, [], NaN, 3.7, '3.7', true, Infinity]) {
      assert.equal(clampTrustLevel(raw), 1, `${JSON.stringify(raw)} should fall back to 1`);
    }
  });

  test('malformed numeric strings do not grant a tier', () => {
    // Regression: parseInt read "4abc" as 4 and "3.7" as 3. Headers arrive as
    // strings, so this was the reachable path.
    for (const raw of ['4abc', '3.7', '0x4', '+4', '4e0', ' 4four']) {
      assert.equal(clampTrustLevel(raw), 1, `"${raw}" should not parse into a tier`);
    }
  });

  test('parses clean numeric strings, as headers always arrive as strings', () => {
    assert.equal(clampTrustLevel('3'), 3);
    assert.equal(clampTrustLevel('1'), 1);
    assert.equal(clampTrustLevel('9'), 4); // still clamped
    assert.equal(clampTrustLevel(' 3 '), 3); // surrounding whitespace tolerated
  });

  test('passes valid levels through unchanged', () => {
    for (const raw of [1, 2, 3, 4]) assert.equal(clampTrustLevel(raw), raw);
  });
});

describe('normalizeSessionRole', () => {
  test('accepts the retrieval role space', () => {
    for (const role of ['prospective', 'student', 'parent', 'staff', 'hod']) {
      assert.equal(normalizeSessionRole(role), role);
    }
  });

  test('unknown or hostile roles degrade to prospective', () => {
    for (const role of ['root', 'superuser', '', null, undefined, 42, {}, 'STAFF', ' staff']) {
      assert.equal(normalizeSessionRole(role), 'prospective', `${JSON.stringify(role)} not neutralised`);
    }
  });

  test('admin and superadmin degrade to prospective for retrieval', () => {
    // Documents real behaviour: the chat proxy treats these as the most
    // privileged roles, but they are not in the retrieval role space, so
    // retrieval scopes them to public namespaces. Fail-closed, but surprising —
    // if admins are ever expected to search staff-internal, that needs an
    // explicit mapping rather than silently landing here.
    assert.equal(normalizeSessionRole('admin'), 'prospective');
    assert.equal(normalizeSessionRole('superadmin'), 'prospective');
  });
});

describe('getSessionContext', () => {
  test('missing context yields the public tier', () => {
    const s = getSessionContext(undefined);
    assert.equal(s.role, 'prospective');
    assert.equal(s.trustLevel, 1);
    assert.equal(s.institutionId, undefined);
    assert.equal(s.userPublicId, undefined);
    assert.equal(s.namespaceAllowlist, undefined);
  });

  test('empty context yields the public tier', () => {
    const s = getSessionContext(new RequestContext());
    assert.equal(s.role, 'prospective');
    assert.equal(s.trustLevel, 1);
  });

  test('reads a well-formed session', () => {
    const s = getSessionContext(contextWith({
      [SESSION_KEYS.role]: 'staff',
      [SESSION_KEYS.trustLevel]: 4,
      [SESSION_KEYS.institutionId]: 'inst-1',
      [SESSION_KEYS.userPublicId]: 'user-1',
      [SESSION_KEYS.namespaceAllowlist]: ['admissions', 'general'],
    }));
    assert.equal(s.role, 'staff');
    assert.equal(s.trustLevel, 4);
    assert.equal(s.institutionId, 'inst-1');
    assert.equal(s.userPublicId, 'user-1');
    assert.deepEqual(s.namespaceAllowlist, ['admissions', 'general']);
  });

  test('hostile values are neutralised rather than trusted', () => {
    const s = getSessionContext(contextWith({
      [SESSION_KEYS.role]: 'superadmin',
      [SESSION_KEYS.trustLevel]: 99,
    }));
    assert.equal(s.role, 'prospective');
    assert.equal(s.trustLevel, 4); // clamped to the ceiling, not granted 99
  });

  test('blank strings become undefined, not empty identifiers', () => {
    const s = getSessionContext(contextWith({
      [SESSION_KEYS.institutionId]: '',
      [SESSION_KEYS.userPublicId]: '',
    }));
    assert.equal(s.institutionId, undefined);
    assert.equal(s.userPublicId, undefined);
  });

  test('non-string identifiers are rejected', () => {
    const s = getSessionContext(contextWith({
      [SESSION_KEYS.institutionId]: 12345,
      [SESSION_KEYS.userPublicId]: { id: 'x' },
    }));
    assert.equal(s.institutionId, undefined);
    assert.equal(s.userPublicId, undefined);
  });

  test('empty allowlist normalises to undefined', () => {
    // Paired with the gate's "empty means not supplied" behaviour: this is what
    // keeps [] from ever reaching resolveNamespaces.
    const s = getSessionContext(contextWith({ [SESSION_KEYS.namespaceAllowlist]: [] }));
    assert.equal(s.namespaceAllowlist, undefined);
  });

  test('non-string entries are stripped from the allowlist', () => {
    const s = getSessionContext(contextWith({
      [SESSION_KEYS.namespaceAllowlist]: ['admissions', 42, null, '', 'general'],
    }));
    assert.deepEqual(s.namespaceAllowlist, ['admissions', 'general']);
  });
});
