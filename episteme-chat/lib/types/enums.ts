// lib/types/enums.ts
//
// Narrowing untrusted strings to database enum values.
//
// Admin list pages take filters straight off the URL query string and hand them
// to `.eq()` on an enum column. While the server Supabase client was untyped
// that compiled silently, and an unrecognised value — `?status=deleted`, or a
// typo — reached PostgREST, which rejects the whole query with a 22P02
// (invalid input value for enum). The list then renders empty with no clue why.
//
// `Constants` is emitted by Supabase typegen alongside the row types, so the
// allowed values come from the same generated file as everything else and
// cannot drift from the database independently.
//
// The convention here is that an unrecognised filter is DROPPED rather than
// rejected: a junk query param should show the unfiltered list, not an error
// page and not a silently empty one.

import { Constants } from "./database";
import type { Enums } from "./database";

type EnumName = keyof typeof Constants.public.Enums;

/**
 * Returns `value` if it is a member of the named database enum, else undefined.
 *
 * @example
 *   const status = asEnum("claim_status", statusFilter);
 *   if (status) query = query.eq("status", status);
 */
export function asEnum<K extends EnumName>(
  name: K,
  value: string | null | undefined,
): Enums<K> | undefined {
  if (!value) return undefined;
  const allowed = Constants.public.Enums[name] as readonly string[];
  return allowed.includes(value) ? (value as Enums<K>) : undefined;
}

/** The allowed values of a database enum, for rendering filter controls. */
export function enumValues<K extends EnumName>(name: K): readonly Enums<K>[] {
  // Double cast: with K still generic, TS sees the indexed access as the union
  // of every enum tuple and cannot prove it narrows to Enums<K>. The runtime
  // relationship holds by construction — both sides are generated from the same
  // schema — so the widening step is safe here.
  return Constants.public.Enums[name] as unknown as readonly Enums<K>[];
}
