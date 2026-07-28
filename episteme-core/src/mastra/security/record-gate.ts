// episteme-core/src/mastra/security/record-gate.ts
/**
 * Record access gate — the authority on WHICH DATABASE ROWS a session may read.
 *
 * Sibling of retrieval-gate.ts, and pure for the same reasons: no I/O, no env
 * reads, no client construction, so the policy is unit-testable without secrets
 * or a database.
 *
 * ── Why records need their own gate ──────────────────────────────────────────
 * Retrieval answers "which namespaces may this session search"; that is a
 * document-visibility question and its unit is a namespace. Records are rows in
 * a multi-tenant relational schema, and their visibility question is different:
 * a HOD may read verification claims, but only their own department's; a staff
 * member only those assigned to them; a student only their own. The same
 * collection is readable by several roles at different widths.
 *
 * ── The one design rule ──────────────────────────────────────────────────────
 * This module does NOT return a boolean. It returns a REQUIRED PREDICATE — the
 * filter the caller must apply. A tool cannot "forget to scope" a query,
 * because it has nothing to build a query from until the gate hands it a scope.
 * Making the unsafe version unrepresentable beats reviewing for it.
 *
 * ── Fail-closed choices worth knowing ────────────────────────────────────────
 *   - No institution → NO records at all. Unlike retrieval, which falls back to
 *     GLOBAL_INSTITUTION for platform-wide documents, there is no global record
 *     tier: every row in this schema belongs to exactly one tenant. A session
 *     with no institution has nothing legitimate to read.
 *   - Unknown roles collapse to the public tier (catalogue + calendar), never
 *     to a wider one.
 *   - Access across several roles is a UNION of what each grants, matching
 *     resolveNamespacesForRoles — a user who is both an admin and a student must
 *     not lose their own student record by being promoted.
 */

/** The record collections a tool may expose. One per planned record tool. */
export const RECORD_COLLECTIONS = ['catalogue', 'calendar', 'claims', 'ownRecord'] as const;
export type RecordCollection = (typeof RECORD_COLLECTIONS)[number];

/**
 * How widely a caller may read `claims`.
 *
 * Ordered from widest to narrowest — `widestClaimScope` relies on this order.
 */
export const CLAIM_SCOPES = ['institution', 'department', 'assigned', 'own'] as const;
export type ClaimScope = (typeof CLAIM_SCOPES)[number];

/**
 * The filter a query MUST apply. Every variant carries institutionId, because
 * tenant isolation is unconditional for every collection without exception.
 */
export type RecordScope =
  | { collection: 'catalogue';  institutionId: string }
  | { collection: 'calendar';   institutionId: string }
  | { collection: 'claims';     institutionId: string; scope: 'institution' }
  | { collection: 'claims';     institutionId: string; scope: 'department'; departmentId: string }
  | { collection: 'claims';     institutionId: string; scope: 'assigned';   userId: string }
  | { collection: 'claims';     institutionId: string; scope: 'own';        userId: string }
  | { collection: 'ownRecord';  institutionId: string; subjectUserId: string };

export interface RecordSession {
  /** Full verified role set — access is their union. */
  roles: string[];
  /** 1–4. Institution- and department-wide claim scopes require 4. */
  trustLevel?: number;
  /** Tenant. Absent → no record access whatsoever. */
  institutionId?: string;
  /** The caller's own users.id. Absent → self-scoped collections are denied. */
  userPublicId?: string;
  /** The HOD's department. Absent → a HOD falls back to assigned-only. */
  departmentId?: string;
  /** Platform operator (admin/superadmin). Grants institution-wide claim scope. */
  isPlatformAdmin?: boolean;
  /**
   * For parents: the linked student's users.id, populated only when the link is
   * verified AND can_view_academic is true. The caller must not pass it
   * otherwise — this gate treats its presence as the permission already granted,
   * exactly as namespaceAllowlist is precomputed for retrieval.
   */
  linkedStudentUserId?: string;
}

/** Roles that may read claims beyond their own submissions. */
const REVIEWER_ROLES = new Set(['staff', 'hod']);

/**
 * Widest claim scope this session may use, or null if it may only read its own.
 *
 * Institution-wide requires the platform-admin bit AND trust 4 — the same pair
 * that gates the platform-admin namespace, and for the same reason: trust 4
 * alone is every lecturer, and the app role alone is forgeable upstream of here
 * if trust is not also verified.
 */
function widestClaimScope(session: RecordSession): ClaimScope | null {
  const { roles, trustLevel = 1, isPlatformAdmin = false, departmentId, userPublicId } = session;

  if (isPlatformAdmin && trustLevel >= 4) return 'institution';
  if (roles.includes('hod') && trustLevel >= 4 && departmentId) return 'department';
  if (roles.some((r) => REVIEWER_ROLES.has(r)) && trustLevel >= 4 && userPublicId) return 'assigned';
  return userPublicId ? 'own' : null;
}

/**
 * Resolve every scope this session may query.
 *
 * Returns at most one scope per collection — the widest the session is entitled
 * to. A tool asks for the collection it needs and receives either a scope it
 * must apply, or nothing, in which case it must not query at all.
 */
export function resolveRecordScopes(session: RecordSession): RecordScope[] {
  const { institutionId, userPublicId, linkedStudentUserId } = session;

  // No tenant → no rows. There is no global record tier.
  if (!institutionId) return [];

  const scopes: RecordScope[] = [];

  // Catalogue and calendar are the institution's public structure — a
  // prospectus. Readable by every authenticated session in the tenant,
  // including trust 1: withholding "which programmes exist" from a prospective
  // student would defeat the point of the assistant.
  scopes.push({ collection: 'catalogue', institutionId });
  scopes.push({ collection: 'calendar',  institutionId });

  const claimScope = widestClaimScope(session);
  if (claimScope === 'institution') {
    scopes.push({ collection: 'claims', institutionId, scope: 'institution' });
  } else if (claimScope === 'department') {
    scopes.push({
      collection: 'claims', institutionId,
      scope: 'department', departmentId: session.departmentId!,
    });
  } else if (claimScope === 'assigned') {
    scopes.push({ collection: 'claims', institutionId, scope: 'assigned', userId: userPublicId! });
  } else if (claimScope === 'own') {
    scopes.push({ collection: 'claims', institutionId, scope: 'own', userId: userPublicId! });
  }

  // A caller's own student record. For a parent, the linked student's — but
  // only when the caller supplied a verified, permitted link. The caller's own
  // record wins when both are available: a parent who is also a student is
  // asking about themselves unless they say otherwise.
  const subjectUserId = userPublicId ?? linkedStudentUserId;
  if (subjectUserId) {
    scopes.push({ collection: 'ownRecord', institutionId, subjectUserId });
  }

  return scopes;
}

/**
 * The scope for one collection, or null when the session may not read it.
 *
 * This is the function tools call. Returning null must mean "do not query" —
 * never "query without a filter".
 */
export function resolveRecordScope(
  session: RecordSession,
  collection: RecordCollection,
): RecordScope | null {
  return resolveRecordScopes(session).find((s) => s.collection === collection) ?? null;
}

/**
 * Render a scope as a human-readable provenance label, for the record source
 * shown beside an answer. Never includes an identifier — a citation is read by
 * the end user, and leaking a UUID into the UI is the same class of mistake as
 * quoting session context back at them.
 */
export function describeScope(scope: RecordScope): string {
  switch (scope.collection) {
    case 'catalogue': return 'Institution programme catalogue';
    case 'calendar':  return 'Institution academic calendar';
    case 'ownRecord': return 'Student record';
    case 'claims':
      switch (scope.scope) {
        case 'institution': return 'Verification claims (institution-wide)';
        case 'department':  return 'Verification claims (your department)';
        case 'assigned':    return 'Verification claims assigned to you';
        case 'own':         return 'Your verification claims';
      }
  }
}
