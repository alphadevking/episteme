// lib/settings/schema.ts
//
// The single source of truth for every user-mutable setting. Imported by BOTH
// the client shell and the PATCH route, so the two can never drift.
//
// ── The one rule that makes settings actually mutable ────────────────────────
//
// The old contract could not express "clear this field". The client sent
// `phone.trim() || undefined`, `undefined` vanished in JSON.stringify, and the
// route wrote a field only `if (clean !== null)` — where `null` was also what
// an empty string became. Set and clear were therefore indistinguishable, and
// clear always lost. The UI's own deselect affordances marked the form dirty,
// reported "Changes saved", and silently reverted on reload.
//
// The fix is to separate the two axes that were collapsed into one:
//
//   key ABSENT from the patch  → "don't touch this field"
//   key PRESENT with a value   → "set it to this"
//   key PRESENT with null      → "clear it"
//
// Every field below is therefore `.nullable()` (clearable) inside a `.partial()`
// object (absence is meaningful). Empty and whitespace-only strings normalise to
// `null` so the client can send raw input verbatim and clearing Just Works —
// there is no `|| undefined` anywhere for a bug to hide in again.
//
// Consumers MUST test presence with `in` / `hasOwnProperty`, never truthiness.
// `lib/settings/patch.ts` is the only place that does this, and it is unit
// tested so the regression cannot come back silently.

import { z } from "zod";
import { LEVEL_OPTIONS } from "@/lib/constants/academic";

// ── Option sets ─────────────────────────────────────────────────────────────

export const STAFF_TITLE_OPTIONS = [
  "Lecturer",
  "Senior Lecturer",
  "Associate Professor",
  "Professor",
  "HOD",
  "Dean",
  "Admin Staff",
  "Lab Technician",
  "Other",
] as const;

export const VERBOSITY_OPTIONS = ["concise", "detailed"] as const;
export const THEME_OPTIONS     = ["light", "dark", "system"] as const;

/**
 * Answer-shape preference. Distinct from verbosity: verbosity is how MUCH, this
 * is what SHAPE. Both are consumed by an explicit rule in the agent
 * instructions — see episteme-core `## Rule 5 — Response style`. Do not add an
 * option here without adding the matching branch there, or it becomes a control
 * that visibly does nothing.
 */
export const ANSWER_FORMAT_OPTIONS = ["prose", "steps"] as const;

export type Verbosity    = (typeof VERBOSITY_OPTIONS)[number];
export type ThemePref    = (typeof THEME_OPTIONS)[number];
export type AnswerFormat = (typeof ANSWER_FORMAT_OPTIONS)[number];
export type StaffTitle   = (typeof STAFF_TITLE_OPTIONS)[number];

// ── Length limits ───────────────────────────────────────────────────────────
//
// The old route validated only `typeof v === "string"`, so an arbitrarily large
// string reached Postgres. These caps are generous for real values and are
// enforced server-side; the client mirrors them as `maxLength` for feedback.

export const SETTINGS_LIMITS = {
  firstName:   80,
  lastName:    80,
  displayName: 120,
  phone:       32,
  programme:   160,
  department:  160,
} as const;

// ── Field builders ──────────────────────────────────────────────────────────

/**
 * A clearable free-text field: trims, treats blank as "clear", enforces a cap.
 *
 * Order matters. `.trim()` runs before `.max()` so trailing whitespace can't
 * push a legitimate value over the limit, and the blank→null transform runs
 * after trimming so "   " is a clear rather than a 3-character value.
 */
const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer.`)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable();

/** A clearable enum: accepts a member, or "" / null meaning "clear". */
const clearableEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.enum(values), z.literal("")])
    .transform((v) => (v === "" ? null : (v as T[number])))
    .nullable();

/**
 * Phone. Deliberately permissive about formatting — Nigerian users write
 * +234 803…, 0803…, and 234-803-… and all three are the same number — but
 * strict about the character class, so free text cannot be smuggled into a
 * field the UI renders as a phone number.
 */
const phoneField = z
  .string()
  .trim()
  .max(SETTINGS_LIMITS.phone, `Must be ${SETTINGS_LIMITS.phone} characters or fewer.`)
  .refine(
    (v) => v.length === 0 || /^\+?[\d\s()\-.]{7,}$/.test(v),
    "Enter a valid phone number, e.g. +234 803 000 0000.",
  )
  .transform((v) => (v.length === 0 ? null : v))
  .nullable();

// ── The patch schema ────────────────────────────────────────────────────────

/**
 * `.partial()` is load-bearing: an absent key means "leave this alone", which is
 * what lets the client send only what actually changed. `.strict()` is also
 * load-bearing: it rejects unknown keys outright rather than letting a typo'd
 * or hostile field name ride along into a JSONB `preferences` blob.
 */
const settingsShape = {
  // users table
  firstName:   clearableText(SETTINGS_LIMITS.firstName),
  lastName:    clearableText(SETTINGS_LIMITS.lastName),
  displayName: clearableText(SETTINGS_LIMITS.displayName),
  phone:       phoneField,

  // user_ai_context columns
  programme: clearableText(SETTINGS_LIMITS.programme),
  level:     clearableEnum(LEVEL_OPTIONS),

  // user_ai_context.preferences (JSONB)
  department:   clearableText(SETTINGS_LIMITS.department),
  staffTitle:   clearableEnum(STAFF_TITLE_OPTIONS),
  verbosity:    clearableEnum(VERBOSITY_OPTIONS),
  answerFormat: clearableEnum(ANSWER_FORMAT_OPTIONS),
  theme:        clearableEnum(THEME_OPTIONS),
};

export const settingsPatchSchema = z.strictObject(settingsShape).partial();

/** A validated patch. Key present = write it; `null` = clear it. */
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/**
 * Every key the patch schema accepts. Derived from the shape object rather than
 * from `settingsPatchSchema.shape` so it stays correct regardless of what the
 * `.partial()` / `.strictObject()` wrappers do to the introspection surface —
 * and so `patch.test.ts` can assert that every key reaches exactly one storage
 * destination, which is what catches a field added here but not mapped there.
 */
export const SETTINGS_KEYS = Object.keys(settingsShape) as (keyof SettingsPatch)[];

// ── Resolved (post-read) settings ───────────────────────────────────────────

/**
 * The settings as they currently stand in the database, with defaults applied.
 * This is what the server page hands the client and what PATCH echoes back so
 * the form can re-baseline without a round trip.
 *
 * Note these are NOT nullable: a read always resolves to a concrete value
 * (empty string for "unset" text, a default for enums). Nullability belongs to
 * the patch — the write direction — only.
 */
export type SettingsValues = {
  firstName:    string;
  lastName:     string;
  displayName:  string;
  phone:        string;
  programme:    string;
  level:        string;
  department:   string;
  staffTitle:   string;
  verbosity:    Verbosity;
  answerFormat: AnswerFormat;
  theme:        ThemePref;
};

export const SETTINGS_DEFAULTS = {
  verbosity:    "concise" as Verbosity,
  answerFormat: "prose"   as AnswerFormat,
  theme:        "system"  as ThemePref,
};

/**
 * Formats a Zod issue into one user-facing sentence.
 *
 * Typed structurally rather than against a Zod-internal issue type, so a minor
 * Zod release renaming that type can't break the build.
 */
export function formatSettingsIssue(issue: { path: PropertyKey[]; message: string }): string {
  const field = String(issue.path[0] ?? "");
  const label = FIELD_LABELS[field] ?? field;
  return label ? `${label}: ${issue.message}` : issue.message;
}

const FIELD_LABELS: Record<string, string> = {
  firstName:    "First name",
  lastName:     "Last name",
  displayName:  "Display name",
  phone:        "Phone",
  programme:    "Programme",
  level:        "Level",
  department:   "Department",
  staffTitle:   "Role / title",
  verbosity:    "Answer length",
  answerFormat: "Answer format",
  theme:        "Theme",
};
