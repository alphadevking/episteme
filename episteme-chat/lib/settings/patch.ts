// lib/settings/patch.ts
//
// Turns a validated `SettingsPatch` into the exact writes three storage
// locations need. Pure and dependency-free (no Supabase, no Next), so the rule
// that used to be wrong — "presence means write, null means clear" — is
// directly unit testable. See `patch.test.ts`.
//
// Storage map:
//   users.first_name / last_name / display_name / phone
//   user_ai_context.programme / level          (real columns)
//   user_ai_context.preferences.*              (JSONB blob)

import type { SettingsPatch, SettingsValues } from "./schema";
import { SETTINGS_DEFAULTS } from "./schema";

/** Which patch key writes to which `users` column. */
const USER_COLUMNS = {
  firstName:   "first_name",
  lastName:    "last_name",
  displayName: "display_name",
  phone:       "phone",
} as const;

/** Which patch key writes to which `user_ai_context` column. */
const CONTEXT_COLUMNS = {
  programme: "programme",
  level:     "level",
} as const;

/**
 * Patch keys that live inside the `preferences` JSONB blob. The stored key name
 * matches the patch key name — kept explicit rather than inferred so adding a
 * field is a deliberate act in one visible list.
 */
const PREFERENCE_KEYS = ["department", "staffTitle", "verbosity", "answerFormat", "theme"] as const;

export type SettingsWritePlan = {
  /** Columns to write on `users`. Empty object = no `users` write needed. */
  users: Record<string, string | null>;
  /** Columns to write on `user_ai_context`. */
  context: Record<string, string | null>;
  /** Preference keys to set, with their values. */
  prefsSet: Record<string, string>;
  /**
   * Preference keys to DELETE from the blob.
   *
   * Deleting rather than storing `null` matters: every reader of this blob uses
   * `prefs.x ?? default`, and `null ?? default` does yield the default — but
   * `JSON.stringify` keeps the null, so the row accumulates tombstones and a
   * reader using `"x" in prefs` (a natural thing to write later) would see a
   * cleared field as still present. Removing the key keeps "cleared" and "never
   * set" genuinely identical.
   */
  prefsUnset: string[];
  /** True when the plan writes nothing at all. */
  isEmpty: boolean;
};

/**
 * Split a validated patch into per-table writes.
 *
 * Presence, not truthiness, decides whether a field is written — `null` is a
 * value here (meaning "clear"), so `if (patch.phone)` and `if (patch.phone !==
 * null)` are BOTH wrong and both silently drop clears. Only `in` is correct.
 */
export function splitSettingsPatch(patch: SettingsPatch): SettingsWritePlan {
  const users:      Record<string, string | null> = {};
  const context:    Record<string, string | null> = {};
  const prefsSet:   Record<string, string> = {};
  const prefsUnset: string[] = [];

  for (const [key, column] of Object.entries(USER_COLUMNS)) {
    if (key in patch) users[column] = patch[key as keyof SettingsPatch] ?? null;
  }

  for (const [key, column] of Object.entries(CONTEXT_COLUMNS)) {
    if (key in patch) context[column] = patch[key as keyof SettingsPatch] ?? null;
  }

  for (const key of PREFERENCE_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value == null) prefsUnset.push(key);
    else prefsSet[key] = value;
  }

  const isEmpty =
    Object.keys(users).length === 0 &&
    Object.keys(context).length === 0 &&
    Object.keys(prefsSet).length === 0 &&
    prefsUnset.length === 0;

  return { users, context, prefsSet, prefsUnset, isEmpty };
}

/**
 * Merge a write plan's preference changes into the existing blob.
 *
 * Read-modify-write, so two concurrent PATCHes for the same user could clobber
 * each other's preference keys. That is acceptable here — both writers are the
 * same person's own settings form, and the losing key is re-shown correctly on
 * the next read. Making it atomic would need a `jsonb_set` RPC, i.e. a schema
 * change, which is owned in Supabase rather than in this repo.
 */
export function mergePreferences(
  existing: Record<string, unknown>,
  plan: Pick<SettingsWritePlan, "prefsSet" | "prefsUnset">,
): Record<string, unknown> {
  const next = { ...existing, ...plan.prefsSet };
  for (const key of plan.prefsUnset) delete next[key];
  return next;
}

// ── Read direction ──────────────────────────────────────────────────────────

type UserRow = {
  first_name:   string | null;
  last_name:    string | null;
  display_name: string | null;
  phone:        string | null;
};

type ContextRow = {
  programme:   string | null;
  level:       string | null;
  preferences: unknown;
} | null;

/** Reads a string from an unknown JSON blob, or "" when absent/wrong-typed. */
function prefString(prefs: Record<string, unknown>, key: string): string {
  const v = prefs[key];
  return typeof v === "string" ? v : "";
}

/** Narrows a stored preference to a known option set, falling back to a default. */
function prefEnum<T extends string>(
  prefs: Record<string, unknown>,
  key: string,
  options: readonly T[],
  fallback: T,
): T {
  const v = prefs[key];
  return options.includes(v as T) ? (v as T) : fallback;
}

/**
 * Resolve stored rows into the concrete settings the form binds to.
 *
 * Also repairs legacy rows where the OAuth trigger stored a full "First Last"
 * in `first_name` and left `last_name` null — splitting on the first space so
 * those users see two populated fields instead of one crowded one.
 */
export function readSettingsValues(user: UserRow, context: ContextRow): SettingsValues {
  const prefs = (context?.preferences ?? {}) as Record<string, unknown>;

  const rawFirst = user.first_name ?? "";
  const spaceIdx = rawFirst.indexOf(" ");
  const hasSplit = spaceIdx > -1 && !user.last_name;

  return {
    firstName:   hasSplit ? rawFirst.slice(0, spaceIdx) : rawFirst,
    lastName:    user.last_name ?? (hasSplit ? rawFirst.slice(spaceIdx + 1) : ""),
    displayName: user.display_name ?? "",
    phone:       user.phone ?? "",
    programme:   context?.programme ?? "",
    level:       context?.level ?? "",
    department:   prefString(prefs, "department"),
    staffTitle:   prefString(prefs, "staffTitle"),
    verbosity:    prefEnum(prefs, "verbosity",    ["concise", "detailed"], SETTINGS_DEFAULTS.verbosity),
    answerFormat: prefEnum(prefs, "answerFormat", ["prose", "steps"],      SETTINGS_DEFAULTS.answerFormat),
    theme:        prefEnum(prefs, "theme",        ["light", "dark", "system"], SETTINGS_DEFAULTS.theme),
  };
}

/**
 * The minimal patch that turns `base` into `next` — only genuinely changed
 * fields, with cleared fields as explicit `null`.
 *
 * Sending a diff rather than the whole form is what keeps a settings save from
 * overwriting a field the user never touched (e.g. one changed in another tab).
 */
export function diffSettings(base: SettingsValues, next: SettingsValues): SettingsPatch {
  const patch: Record<string, string | null> = {};
  for (const key of Object.keys(base) as (keyof SettingsValues)[]) {
    if (base[key] === next[key]) continue;
    const value = next[key];
    patch[key] = value === "" ? null : value;
  }
  return patch as SettingsPatch;
}
