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
 * Platform (product) documentation namespaces.
 *
 * Deliberately NOT members of ROLE_NAMESPACES / TRUST_NAMESPACES. Those two
 * tables gate *institutional* content — content that belongs to a tenant, is
 * scoped by programme/level, and for parents is further narrowed by their link
 * permissions. Platform docs are none of those things: they describe Episteme
 * itself, are identical for every tenant (ingested under GLOBAL_INSTITUTION),
 * and must not be reachable-or-not based on whether a parent may view fees.
 *
 * Folding them into ROLE_NAMESPACES would do exactly that — a parent whose link
 * grants no fee permission carries an allowlist of ['admissions','general'],
 * which would strip 'platform-help' and leave them unable to ask how to use the
 * product. So platform access is resolved on its own axis and unioned at the
 * end; see resolvePlatformNamespaces.
 */
export const PLATFORM_HELP_NAMESPACE  = 'platform-help';
export const PLATFORM_ADMIN_NAMESPACE = 'platform-admin';

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
  const { role, ...rest } = input;
  return resolveNamespacesForRoles({ roles: [role], ...rest });
}

/**
 * Multi-role form of resolveNamespaces — the union of what each of the caller's
 * VERIFIED roles may search.
 *
 * A user can genuinely hold several roles at once (an institution admin who is
 * also a student; a parent who is also staff). Collapsing that to the single
 * highest-priority role, as the chat proxy does for display purposes, silently
 * REMOVES access: an admin-who-is-a-student resolves to 'staff' and can no
 * longer retrieve a document tagged only for students. Access is a union, not a
 * ranking.
 *
 * Order is preserved (first role's namespaces first, deduped), so the
 * single-role case returns byte-identical output to the previous
 * implementation — see the property test in retrieval-gate.test.ts.
 *
 * The trust ceiling is applied per role and therefore bounds the union too: no
 * combination of roles can reach a namespace the caller's trust level forbids.
 *
 * @param namespaceAllowlist Parent link permissions. Applied to the 'parent'
 *   role's contribution ONLY when the caller actually holds the parent role —
 *   a parent who is also a student must not have their own student access
 *   clipped by what their child's link permits. When no parent role is present
 *   the allowlist narrows the whole union, preserving the previous conservative
 *   behaviour for a shape that should not occur (the chat proxy only sends an
 *   allowlist for parents).
 */
export function resolveNamespacesForRoles(input: {
  roles: string[];
  trustLevel?: number;
  namespaceAllowlist?: string[];
}): string[] {
  const { roles, trustLevel = 1, namespaceAllowlist } = input;

  const trustNs = TRUST_NAMESPACES[trustLevel] ?? TRUST_NAMESPACES[1];
  const trustSet = new Set(trustNs);

  // Fail closed: an empty or all-unknown role set is the public tier, never a
  // wider one. Unknown roles individually degrade to 'prospective' below.
  const effectiveRoles = roles.length > 0 ? roles : ['prospective'];

  const hasParent = effectiveRoles.includes('parent');
  const allowSet =
    namespaceAllowlist && namespaceAllowlist.length > 0
      ? new Set(namespaceAllowlist)
      : null;

  const union: string[] = [];
  const seen = new Set<string>();

  for (const role of effectiveRoles) {
    const roleNs = ROLE_NAMESPACES[role] ?? ROLE_NAMESPACES['prospective'];
    for (const ns of roleNs) {
      if (!trustSet.has(ns)) continue;
      // Allowlist scoping: see the @param note above.
      if (allowSet && (role === 'parent' || !hasParent) && !allowSet.has(ns)) continue;
      if (seen.has(ns)) continue;
      seen.add(ns);
      union.push(ns);
    }
  }

  return union;
}

/**
 * Platform-documentation namespaces available to a session.
 *
 * Resolved independently of role/trust/allowlist for the reasons given on
 * PLATFORM_HELP_NAMESPACE. Two tiers:
 *
 *   platform-help  — how to USE Episteme. Available to everyone, including the
 *                    public tier: a prospective student asking "how do I ask
 *                    this thing a question" must get an answer.
 *   platform-admin — how to OPERATE Episteme (institution setup, ingesting
 *                    documents, managing users). Requires BOTH trust 4 and an
 *                    explicit platform-admin session bit.
 *
 * `isPlatformAdmin` is carried separately rather than inferred from the
 * retrieval role because the chat proxy aliases admin/superadmin onto 'staff'
 * (RETRIEVAL_ROLE) — by the time a session reaches retrieval, "is this person
 * an operator of the platform" has already been erased. Inferring it from
 * role==='staff' would hand the operator runbook to every lecturer. Absent
 * bit → false, so it fails closed.
 */
export function resolvePlatformNamespaces(input: {
  trustLevel?: number;
  isPlatformAdmin?: boolean;
}): string[] {
  const { trustLevel = 1, isPlatformAdmin = false } = input;
  const namespaces = [PLATFORM_HELP_NAMESPACE];
  if (isPlatformAdmin && trustLevel >= 4) namespaces.push(PLATFORM_ADMIN_NAMESPACE);
  return namespaces;
}

// NOTE: there is deliberately no combined "all namespaces" helper. Platform
// namespaces are NOT Pinecone partitions — the platform tier reads Markdown from
// disk (see tools/platform-docs-tier.ts). Handing them to the vector search
// would query partitions that will always be empty. The two resolvers stay
// separate and are consumed by their own tiers.

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
  /** One role, or the caller's full verified role set. A single string behaves
   *  exactly as before: `{ roles: { $in: ['student'] } }`. Passing several
   *  matches a document tagged for ANY of them, which is the union semantics
   *  resolveNamespacesForRoles applies on the namespace side — the document
   *  metadata field is itself a list, so this is the same list-membership test
   *  already used for `levels` below. */
  role: string | string[];
  programme?: string;
  level?: string;
  institutionId?: string;
}): RetrievalFilter {
  const { role, programme, level, institutionId } = input;
  const roleList = Array.isArray(role) ? role : [role];

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
      { roles: { $in: roleList } },
      ...programmeClause,
      ...levelClause,
      institutionFilter,
    ],
  };
}
