// lib/session-derivation.ts
/**
 * Pure derivation of the trusted session values the chat route forwards to
 * episteme-core as headers (role, trust level). Kept dependency-free so the
 * security logic is unit-testable without Supabase or Next.
 *
 * The one rule that matters: role and trust are derived ONLY from the verified
 * `users` row (primary_role + roles), never from `user_ai_context`. That table
 * is user-writable, so trusting its `role`/`trust_level` was a privilege-
 * escalation vector — a student could set role=staff, trust_level=4 on their
 * own row and pull staff-internal documents.
 */

/** App-level role priority. Higher = more privileged. */
export const ROLE_PRIORITY: Record<string, number> = {
  superadmin: 7,
  admin: 6,
  hod: 5,
  staff: 4,
  student: 3,
  parent: 2,
  guardian: 2,
  prospective: 1,
};

/**
 * App role → retrieval role space understood by episteme-core (ROLE_NAMESPACES).
 * admin/superadmin have no retrieval namespaces of their own; they map to staff,
 * the most privileged retrieval role.
 */
export const RETRIEVAL_ROLE: Record<string, string> = {
  superadmin: 'staff',
  admin: 'staff',
  hod: 'hod',
  staff: 'staff',
  student: 'student',
  parent: 'parent',
  guardian: 'parent',
  prospective: 'prospective',
};

/**
 * App roles that make someone an operator of the PLATFORM, as distinct from a
 * privileged member of a tenant. Sent as its own header because RETRIEVAL_ROLE
 * aliases these onto 'staff' — without it, "is this person an Episteme
 * operator" is erased before retrieval sees the session, and the platform-admin
 * runbook would have to be granted to every staff member or to nobody.
 */
const PLATFORM_ADMIN_ROLES = new Set(['superadmin', 'admin']);

/**
 * The caller's full retrieval role set — the UNION of every verified app role,
 * mapped into the retrieval role space and deduped.
 *
 * resolveEffectiveRole picks a single winner by priority, which is right for
 * display and for the trust ceiling but wrong for access: a user with
 * roles ['student','admin'] resolves to 'admin' → 'staff', and then cannot
 * retrieve a single student-tagged document. Access is a union, not a ranking.
 *
 * Order: the effective (highest-priority) role first, so the emitted header
 * reads consistently and single-role callers are unchanged.
 */
export function resolveRetrievalRoles(primaryRole: string, roles: string[]): string[] {
  const effective = resolveEffectiveRole(primaryRole, roles);
  const mapped = [effective, primaryRole, ...roles]
    .filter(Boolean)
    .map((r) => RETRIEVAL_ROLE[r])
    .filter((r): r is string => Boolean(r));
  const deduped = Array.from(new Set(mapped));
  return deduped.length > 0 ? deduped : ['prospective'];
}

/** True when any verified app role makes this user a platform operator. */
export function isPlatformAdmin(primaryRole: string, roles: string[]): boolean {
  return [primaryRole, ...roles].filter(Boolean).some((r) => PLATFORM_ADMIN_ROLES.has(r));
}

/**
 * Roles whose trust ceiling is the verified role itself, not a stored value.
 * These earn full-access (trust 4) purely from being the role — the role now
 * comes from the verified users row, so this cannot be self-granted.
 */
const ELEVATED_ROLES = new Set(['superadmin', 'admin', 'hod', 'staff']);

/**
 * The most privileged role from primary_role + the roles array, ignoring
 * "prospective" whenever any elevated role is present. Unknown roles score 0
 * and never win, so a junk value cannot out-rank a real one.
 */
export function resolveEffectiveRole(primaryRole: string, roles: string[]): string {
  const candidates = [primaryRole, ...roles].filter(Boolean);
  if (candidates.length === 0) return 'prospective';
  const elevated = candidates.filter((r) => r !== 'prospective');
  const pool = elevated.length > 0 ? elevated : candidates;
  return pool.reduce((best, r) =>
    (ROLE_PRIORITY[r] ?? 0) > (ROLE_PRIORITY[best] ?? 0) ? r : best,
  );
}

/**
 * Derive the trust level (1–4) sent to episteme-core.
 *
 * Elevated roles are pinned to 4 from the verified role alone. Everyone else is
 * capped at 3: trust 4 unlocks staff-internal, which no non-elevated retrieval
 * role can reach anyway, so there is never a reason to grant it — and capping
 * blocks a self-set `user_ai_context.trust_level = 4` from having any effect.
 *
 * NOTE (interim): for non-elevated roles the stored value is still read from the
 * user-writable `user_ai_context.trust_level`, so a student could self-claim
 * trust 3 (programme/academic-policy scope) without portal verification. The
 * role gate keeps them out of staff-internal regardless; the residual is closed
 * fully by the migration that makes `trust_level` non-user-writable.
 *
 * @param appRole   Verified effective app role (from resolveEffectiveRole).
 * @param storedTrust Raw `user_ai_context.trust_level`, or undefined.
 */
export function deriveTrustLevel(appRole: string, storedTrust: unknown): number {
  if (ELEVATED_ROLES.has(appRole)) return 4;
  const n =
    typeof storedTrust === 'number' && Number.isInteger(storedTrust)
      ? storedTrust
      : 1;
  return Math.min(3, Math.max(1, n));
}
