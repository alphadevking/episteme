// lib/settings/patch.test.ts
/**
 * Regression guard for the settings mutability contract.
 *
 * The bug these exist to prevent: settings could be SET but never CLEARED. The
 * client sent `phone.trim() || undefined`, JSON.stringify dropped the key, and
 * the route wrote a field only `if (clean !== null)` — where `null` was also
 * what an empty string became. Clearing a field marked the form dirty, reported
 * "Changes saved", and silently reverted on reload. If the only change WAS a
 * clear, the route rejected the whole save with "No valid fields to update".
 *
 * The invariant now: absence means "leave alone", `null` means "clear". Any
 * future change that reintroduces truthiness checks fails here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { settingsPatchSchema, SETTINGS_KEYS, SETTINGS_LIMITS } from './schema';
import {
  splitSettingsPatch,
  mergePreferences,
  readSettingsValues,
  diffSettings,
} from './patch';
import type { SettingsValues } from './schema';

// ── The core contract ───────────────────────────────────────────────────────

describe('splitSettingsPatch — absence vs null', () => {
  test('an absent key writes nothing for that field', () => {
    const plan = splitSettingsPatch({ firstName: 'Ada' });
    assert.deepEqual(plan.users, { first_name: 'Ada' });
    assert.ok(!('phone' in plan.users), 'wrote a field that was not in the patch');
    assert.ok(!('last_name' in plan.users), 'wrote a field that was not in the patch');
    assert.deepEqual(plan.context, {});
  });

  test('an explicit null CLEARS the field — the original bug', () => {
    const plan = splitSettingsPatch({ phone: null });
    assert.deepEqual(plan.users, { phone: null });
    assert.equal(plan.isEmpty, false, 'a clear-only patch must not be treated as empty');
  });

  test('a clear-only patch is a real update, not "no valid fields"', () => {
    // The exact 400 users hit when their only change was emptying a field.
    for (const key of SETTINGS_KEYS) {
      const plan = splitSettingsPatch({ [key]: null });
      assert.equal(plan.isEmpty, false, `clearing ${key} was treated as an empty patch`);
    }
  });

  test('every schema key reaches exactly one storage location', () => {
    // Guards against adding a field to the schema and forgetting to map it —
    // which would render a control that silently discards its value.
    for (const key of SETTINGS_KEYS) {
      const plan = splitSettingsPatch({ [key]: null });
      const destinations =
        Object.keys(plan.users).length +
        Object.keys(plan.context).length +
        Object.keys(plan.prefsSet).length +
        plan.prefsUnset.length;
      assert.equal(destinations, 1, `${key} mapped to ${destinations} destinations, expected 1`);
    }
  });

  test('an empty patch is empty', () => {
    assert.equal(splitSettingsPatch({}).isEmpty, true);
  });

  test('preferences: setting and clearing are separate lists', () => {
    const plan = splitSettingsPatch({ verbosity: 'detailed', staffTitle: null });
    assert.deepEqual(plan.prefsSet, { verbosity: 'detailed' });
    assert.deepEqual(plan.prefsUnset, ['staffTitle']);
  });
});

// ── Schema normalisation ────────────────────────────────────────────────────

describe('settingsPatchSchema', () => {
  test('an empty string is a clear, not a value', () => {
    const parsed = settingsPatchSchema.parse({ phone: '', programme: '', level: '' });
    assert.equal(parsed.phone, null);
    assert.equal(parsed.programme, null);
    assert.equal(parsed.level, null);
  });

  test('whitespace-only is a clear, not a 3-character value', () => {
    assert.equal(settingsPatchSchema.parse({ firstName: '   ' }).firstName, null);
  });

  test('values are trimmed', () => {
    assert.equal(settingsPatchSchema.parse({ firstName: '  Ada  ' }).firstName, 'Ada');
  });

  test('trailing whitespace cannot push a valid value over the limit', () => {
    const atLimit = 'a'.repeat(SETTINGS_LIMITS.firstName);
    const parsed  = settingsPatchSchema.parse({ firstName: `  ${atLimit}  ` });
    assert.equal(parsed.firstName, atLimit);
  });

  test('over-length input is rejected rather than truncated', () => {
    const tooLong = 'a'.repeat(SETTINGS_LIMITS.firstName + 1);
    assert.equal(settingsPatchSchema.safeParse({ firstName: tooLong }).success, false);
  });

  test('unknown keys are rejected, not smuggled into preferences', () => {
    const result = settingsPatchSchema.safeParse({ trust_level: 4, isSuperadmin: true });
    assert.equal(result.success, false, 'unknown keys must not be accepted');
  });

  test('an out-of-set enum value is rejected', () => {
    assert.equal(settingsPatchSchema.safeParse({ verbosity: 'exhaustive' }).success, false);
    assert.equal(settingsPatchSchema.safeParse({ level: '900L' }).success, false);
    assert.equal(settingsPatchSchema.safeParse({ theme: 'neon' }).success, false);
  });

  test('phone accepts the formats Nigerian users actually type', () => {
    for (const v of ['+234 803 000 0000', '08030000000', '234-803-000-0000', '(0803) 000 0000']) {
      assert.equal(settingsPatchSchema.safeParse({ phone: v }).success, true, `rejected ${v}`);
    }
  });

  test('phone rejects free text', () => {
    assert.equal(settingsPatchSchema.safeParse({ phone: 'call me maybe' }).success, false);
  });
});

// ── Preference merging ──────────────────────────────────────────────────────

describe('mergePreferences', () => {
  test('untouched keys survive a write', () => {
    const next = mergePreferences(
      { verbosity: 'detailed', department: 'Computer Science' },
      { prefsSet: { theme: 'dark' }, prefsUnset: [] },
    );
    assert.deepEqual(next, { verbosity: 'detailed', department: 'Computer Science', theme: 'dark' });
  });

  test('a cleared key is removed, not set to null', () => {
    // A null tombstone would make "cleared" and "never set" distinguishable to
    // any reader using `in`, which is a trap for future code.
    const next = mergePreferences(
      { staffTitle: 'Lecturer', verbosity: 'concise' },
      { prefsSet: {}, prefsUnset: ['staffTitle'] },
    );
    assert.deepEqual(next, { verbosity: 'concise' });
    assert.ok(!('staffTitle' in next), 'left a tombstone behind');
  });

  test('the existing blob is not mutated in place', () => {
    const existing = { verbosity: 'concise' };
    mergePreferences(existing, { prefsSet: { theme: 'dark' }, prefsUnset: ['verbosity'] });
    assert.deepEqual(existing, { verbosity: 'concise' }, 'mutated the caller\'s object');
  });
});

// ── Read direction ──────────────────────────────────────────────────────────

describe('readSettingsValues', () => {
  const emptyUser = { first_name: null, last_name: null, display_name: null, phone: null };

  test('missing rows resolve to defaults, never undefined', () => {
    const v = readSettingsValues(emptyUser, null);
    assert.equal(v.firstName, '');
    assert.equal(v.verbosity, 'concise');
    assert.equal(v.answerFormat, 'prose');
    assert.equal(v.theme, 'system');
  });

  test('a legacy full-name row is split across both name fields', () => {
    // The OAuth trigger stored "Ada Lovelace" in first_name and left last_name null.
    const v = readSettingsValues({ ...emptyUser, first_name: 'Ada Lovelace' }, null);
    assert.equal(v.firstName, 'Ada');
    assert.equal(v.lastName, 'Lovelace');
  });

  test('a real last name is never overwritten by the legacy split', () => {
    // Multi-word first names are legitimate; splitting them would corrupt data.
    const v = readSettingsValues(
      { ...emptyUser, first_name: 'Mary Jane', last_name: 'Okafor' },
      null,
    );
    assert.equal(v.firstName, 'Mary Jane');
    assert.equal(v.lastName, 'Okafor');
  });

  test('a junk stored enum falls back to the default instead of rendering blank', () => {
    const v = readSettingsValues(emptyUser, {
      programme: null,
      level: null,
      preferences: { verbosity: 42, theme: 'neon' },
    });
    assert.equal(v.verbosity, 'concise');
    assert.equal(v.theme, 'system');
  });
});

// ── Round trip ──────────────────────────────────────────────────────────────

describe('diffSettings', () => {
  const base: SettingsValues = {
    firstName: 'Ada', lastName: 'Lovelace', displayName: '', phone: '+234 803 000 0000',
    programme: 'Computer Science (CSC)', level: '300L', department: '', staffTitle: '',
    verbosity: 'concise', answerFormat: 'prose', theme: 'system',
  };

  test('no changes produce an empty patch', () => {
    assert.deepEqual(diffSettings(base, { ...base }), {});
  });

  test('only changed fields are sent', () => {
    assert.deepEqual(diffSettings(base, { ...base, level: '400L' }), { level: '400L' });
  });

  test('an emptied field becomes an explicit null', () => {
    assert.deepEqual(diffSettings(base, { ...base, phone: '' }), { phone: null });
  });

  test('the full round trip clears a field end to end', () => {
    // diff → validate → split. This is the exact path a save takes, and the
    // path where clearing used to be lost at every one of the three stages.
    const patch  = diffSettings(base, { ...base, phone: '', level: '' });
    const parsed = settingsPatchSchema.parse(patch);
    const plan   = splitSettingsPatch(parsed);

    assert.deepEqual(plan.users, { phone: null });
    assert.deepEqual(plan.context, { level: null });
    assert.equal(plan.isEmpty, false);
  });

  test('a diff is always accepted by the schema', () => {
    const next: SettingsValues = {
      firstName: '', lastName: '', displayName: 'Ada L.', phone: '',
      programme: '', level: '500L', department: 'Physics', staffTitle: 'Professor',
      verbosity: 'detailed', answerFormat: 'steps', theme: 'dark',
    };
    const result = settingsPatchSchema.safeParse(diffSettings(base, next));
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });
});
