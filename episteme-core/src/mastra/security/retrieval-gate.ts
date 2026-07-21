// episteme-core/src/mastra/security/retrieval-gate.ts
/**
 * Retrieval access gate — the authority on WHAT a session is allowed to search.
 *
 * This module is deliberately pure: no I/O, no env reads, no client construction.
 * The retrieval tool and the ingestion pipeline both build Pinecone clients at
 * import scope (which throw without credentials), so keeping the policy here is
 * what makes it unit-testable without secrets or network.
 *
 * Two independent gates, both enforced on every query:
 *
 *   1. Namespace gate — intersection(role's namespaces, trust level's ceiling).
 *      Role alone can never grant access; the trust ceiling always applies.
 *      Inputs come from the server-injected session, never from the model.
 *
 *   2. Institution gate — every query is filtered to the caller's institution
 *      plus globally-shared docs, so one tenant can never read another's.
 */

/** Sentinel institution ID for documents shared across all tenants. */
export const GLOBAL_INSTITUTION = '__global__';

/**
 * Role → searchable namespaces.
 *
 * This is NOT a topical-relevance curation — it intersects with TRUST_NAMESPACES
 * (and, for parents, a further per-family allowlist), which are the gates that
 * actually carry security weight. Every namespace except 'staff-internal' is
 * reachable at trust level 1+, i.e. genuinely public institutional content —
 * restricting it further by role adds no confidentiality, only false negatives.
 * That's not hypothetical: a 'student' excluded from 'admissions' couldn't
 * retrieve the transfer/re-admission policy that's squarely relevant to an
 * enrolled student, and a 'parent' excluded from 'academic-policy' couldn't
 * reach it even with can_view_academic=true on their student link, because the
 * allowlist can only narrow what's here — it can never add back what this list
 * never granted. So: every non-staff role gets every namespace except
 * 'staff-internal', which stays excluded here as defense-in-depth alongside
 * the trust ceiling (which already blocks it below trust 4 on its own).
 */
export const ROLE_NAMESPACES: Record<string, string[]> = {
  prospective: ['admissions', 'academic-policy', 'financial-aid', 'programmes', 'general'],
  student:     ['admissions', 'academic-policy', 'financial-aid', 'programmes', 'general'],
  parent:      ['admissions', 'academic-policy', 'financial-aid', 'programmes', 'general'],
  staff:       ['admissions', 'academic-policy', 'financial-aid', 'programmes', 'staff-internal', 'general'],
  hod:         ['admissions', 'academic-policy', 'financial-aid', 'programmes', 'staff-internal', 'general'],
};

/**
 * Trust level → maximum allowed namespaces (hard ceiling).
 *
 *  1 = public-only (unverified / prospective)
 *  2 = programme-info (unverified student)
 *  3 = personal-academic (portal-verified student)
 *  4 = full-access (staff / HOD / superadmin)
 *
 * Only trust 4 unlocks 'staff-internal'. A claimed role of "staff" at trust 1
 * still resolves to public namespaces only — that intersection is the gate.
 */
export const TRUST_NAMESPACES: Record<number, string[]> = {
  1: ['admissions', 'programmes', 'general'],
  2: ['admissions', 'programmes', 'general'],
  3: ['admissions', 'academic-policy', 'financial-aid', 'programmes', 'general'],
  4: ['admissions', 'academic-policy', 'financial-aid', 'programmes', 'staff-internal', 'general'],
};

/**
 * Resolve the namespaces a session may search.
 *
 * Fails closed on unknown input: an unrecognised role degrades to `prospective`
 * and an unrecognised trust level degrades to 1 (public-only) — never upward.
 *
 * @param namespaceAllowlist Optional further restriction (parent link
 *   permissions). It can only ever narrow the result, never widen it. An empty
 *   array is treated as "not supplied" — callers must pass a populated list or
 *   omit it entirely.
 */
export function resolveNamespaces(input: {
  role: string;
  trustLevel?: number;
  namespaceAllowlist?: string[];
}): string[] {
  const { role, trustLevel = 1, namespaceAllowlist } = input;

  const roleNs = ROLE_NAMESPACES[role] ?? ROLE_NAMESPACES['prospective'];
  const trustNs = TRUST_NAMESPACES[trustLevel] ?? TRUST_NAMESPACES[1];

  const trustSet = new Set(trustNs);
  let namespaces = roleNs.filter((ns) => trustSet.has(ns));

  if (namespaceAllowlist && namespaceAllowlist.length > 0) {
    const allowSet = new Set(namespaceAllowlist);
    namespaces = namespaces.filter((ns) => allowSet.has(ns));
  }

  return namespaces;
}

/** Pinecone metadata filter shape. Loose by design — mirrors the query API. */
export type RetrievalFilter = {
  $and: Array<Record<string, unknown>>;
};

/**
 * Build the Pinecone metadata filter for a query.
 *
 * Institution isolation is unconditional: results are always constrained to
 * `$in: [callerInstitution, GLOBAL_INSTITUTION]`. Omitting institutionId
 * narrows to globally-shared documents only — it never opens access.
 */
export function buildRetrievalFilter(input: {
  role: string;
  programme?: string;
  level?: string;
  institutionId?: string;
}): RetrievalFilter {
  const { role, programme, level, institutionId } = input;

  const resolvedInstitutionId = institutionId ?? GLOBAL_INSTITUTION;
  const institutionFilter = {
    institutionId: { $in: [resolvedInstitutionId, GLOBAL_INSTITUTION] },
  };

  const programmeClause = programme
    ? [{ $or: [{ programme: { $eq: programme } }, { programme: { $exists: false } }] }]
    : [];
  // Documents may be tagged with several levels (e.g. a shared postgraduate
  // handbook tagged ["MSc", "PhD", "PGD"]) — $in checks list membership,
  // matching the caller's single level against any element in that list.
  const levelClause = level
    ? [{ $or: [{ levels: { $in: [level] } }, { levels: { $exists: false } }] }]
    : [];

  return {
    $and: [
      { roles: { $in: [role] } },
      ...programmeClause,
      ...levelClause,
      institutionFilter,
    ],
  };
}
