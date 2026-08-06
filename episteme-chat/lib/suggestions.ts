// lib/suggestions.ts
// Role- and trust-aware chat suggestions, resolved from the canonical catalogue.
//
// WHY THIS IS NOT A HARDCODED LIST ANY MORE
//
// The previous version keyed four fixed chips off `primary_role`. Two things
// were wrong with that, and both produced chips that could only ever fail:
//
//   1. It ignored TRUST. Access is intersection(role namespaces, trust ceiling).
//      A chip whose source lives in `academic-policy` is unreachable below
//      trust 3, so showing it to an unverified student guaranteed a refusal.
//
//   2. It ignored the CORPUS. Chips existed for scholarships, fees, results,
//      accreditation and departmental budgets — none of which any ingested
//      document covers. A suggestion chip is a promise the product makes; the
//      first click was often spent on "I don't have information on that".
//
// The catalogue records, per entry, which roles and trust level can actually
// reach its backing source, and the retrieval eval asserts those claims stay
// true. See suggestions.catalogue.json for the admission rule.

import catalogue from "./suggestions.catalogue.json";

/** What the UI consumes. Unchanged shape — components read label + prompt. */
export type Suggestion = {
  id:     string;
  label:  string;
  prompt: string;
};

/** A catalogue entry, including the provenance the eval asserts against. */
export type CatalogueEntry = Suggestion & {
  /**
   * RETRIEVAL roles that can reach the backing source — mirrors the record-level
   * `roles` metadata on the document, not merely the namespace grant. The two
   * differ (an HOD holds the `admissions` namespace but matches no record in it).
   */
  roles:                 string[];
  /** Trust level at which the backing namespace opens. */
  minTrust:              number;
  tier:                  "kb" | "platform";
  /**
   * The namespace holding the backing source. Used to honour a parent's
   * link-derived allowlist, which can only ever NARROW access — a parent with
   * no fee permission must not be shown a chip whose source sits in
   * `financial-aid`, even though their role and trust would otherwise allow it.
   * Platform namespaces are resolved on their own axis and are never narrowed
   * by the allowlist; see resolvePlatformNamespaces.
   */
  namespace:             string;
  /** Substring the eval expects in a returned source. */
  expectedSource:        string;
  requiresPlatformAdmin?: boolean;
  why:                   string;
};

export const CATALOGUE: CatalogueEntry[] = catalogue.suggestions as CatalogueEntry[];

/** How many chips the welcome grid shows. */
export const MAX_SUGGESTIONS = 4;

export type SuggestionContext = {
  /**
   * The caller's RETRIEVAL roles — the union from `resolveRetrievalRoles`, not
   * `primary_role`. A user with roles ['student','hod'] queries with both, so
   * showing them only one role's chips misrepresents what they can ask.
   */
  roles:            string[];
  /** From `deriveTrustLevel`. Defaults to the floor, never upward. */
  trustLevel?:      number;
  /** The platform-operator bit, from `isPlatformAdmin`. */
  isPlatformAdmin?: boolean;
  /**
   * A parent's link-derived namespace allowlist. Narrows only; omit when the
   * caller holds no parent role, exactly as the chat route does.
   */
  namespaceAllowlist?: string[] | null;
  limit?:           number;
};

/**
 * Chips this caller can actually get an answer to.
 *
 * Fails closed on every axis: an unknown trust level degrades to 1, a missing
 * operator bit hides operator content, and an empty role list matches nothing
 * except entries open to the role it degrades to. Returning FEWER chips is
 * always the correct failure mode — a missing suggestion costs a user nothing,
 * while a dead one costs them their first impression.
 */
export function getSuggestions(ctx: SuggestionContext): Suggestion[] {
  const roles = ctx.roles.length > 0 ? ctx.roles : ["prospective"];
  // Clamp rather than trust: the caller derives this, but a bad value must not
  // widen what we advertise.
  const trust = Number.isInteger(ctx.trustLevel) ? Math.max(1, Math.min(4, ctx.trustLevel as number)) : 1;
  const isOperator = ctx.isPlatformAdmin === true;
  const limit = ctx.limit ?? MAX_SUGGESTIONS;

  const roleSet = new Set(roles);
  // An empty array means "not supplied" — matching resolveNamespaces, where an
  // empty allowlist would otherwise deny everything.
  const allowlist =
    ctx.namespaceAllowlist && ctx.namespaceAllowlist.length > 0
      ? new Set(ctx.namespaceAllowlist)
      : null;

  return CATALOGUE.filter((entry) => {
    if (entry.requiresPlatformAdmin && !isOperator) return false;
    if (trust < entry.minTrust) return false;
    // Platform docs sit outside the institutional namespace axis, so a parent's
    // allowlist must not strip their ability to ask how the product works.
    if (allowlist && entry.tier === "kb" && !allowlist.has(entry.namespace)) return false;
    return entry.roles.some((r) => roleSet.has(r));
  })
    .slice(0, limit)
    .map(({ id, label, prompt }) => ({ id, label, prompt }));
}
