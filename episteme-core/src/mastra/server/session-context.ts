// episteme-core/src/mastra/server/session-context.ts
/**
 * Trusted session context — the security boundary between the LLM and retrieval.
 *
 * Security-critical identity values (role, trust level, institution, user ID,
 * parent namespace allowlist) are injected into Mastra's RequestContext by the
 * chat-security middleware from headers sent by the authenticated episteme-chat
 * proxy. Tools read them via getSessionContext() and NEVER accept them as LLM
 * tool arguments — a prompt injection cannot escalate what the model was never
 * asked to carry.
 */
import type { RequestContext } from '@mastra/core/request-context';

export const SESSION_KEYS = {
  role:               'episteme.role',
  /** Full verified role set. Optional — absent means "just `role`". */
  roles:              'episteme.roles',
  trustLevel:         'episteme.trustLevel',
  institutionId:      'episteme.institutionId',
  userPublicId:       'episteme.userPublicId',
  namespaceAllowlist: 'episteme.namespaceAllowlist',
  /** Operator of the platform (app role admin/superadmin), not of the tenant. */
  isPlatformAdmin:    'episteme.isPlatformAdmin',
} as const;

/** Retrieval role space — matches ROLE_NAMESPACES in knowledge-retrieval-tool. */
export const SESSION_ROLES = ['prospective', 'student', 'parent', 'staff', 'hod'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

export interface SessionContext {
  /**
   * Highest-priority verified role. Retained as the persona/display role and as
   * the single-role fallback; `roles` is what retrieval actually gates on.
   */
  role: SessionRole;
  /**
   * The caller's full verified role set, deduped, always non-empty. Falls back
   * to `[role]` when the proxy sends no role set, so an older chat deployment
   * against a newer core behaves exactly as before.
   */
  roles: SessionRole[];
  /** 1–4, hard-clamped. 1 = public-only. */
  trustLevel: number;
  institutionId?: string;
  userPublicId?: string;
  /** Explicit namespace allowlist for parent users (link permissions). */
  namespaceAllowlist?: string[];
  /**
   * True when the caller operates the PLATFORM (app role admin/superadmin), as
   * opposed to holding a privileged role within a tenant. Carried explicitly
   * because RETRIEVAL_ROLE aliases admin→staff, erasing the distinction before
   * it reaches retrieval. Gates the platform-admin namespace. Defaults false.
   */
  isPlatformAdmin: boolean;
}

export function normalizeSessionRole(raw: unknown): SessionRole {
  return SESSION_ROLES.includes(raw as SessionRole) ? (raw as SessionRole) : 'prospective';
}

/**
 * Normalize a role set. Unknown entries are DROPPED rather than degraded to
 * 'prospective' — a set is a union, so mapping junk onto a real role would let
 * a malformed header add access. An empty result falls back to `[fallback]`.
 */
export function normalizeSessionRoles(raw: unknown, fallback: SessionRole): SessionRole[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];

  const valid = list
    .map((r) => (typeof r === 'string' ? r.trim() : r))
    .filter((r): r is SessionRole => SESSION_ROLES.includes(r as SessionRole));

  const deduped = Array.from(new Set(valid));
  return deduped.length > 0 ? deduped : [fallback];
}

export function clampTrustLevel(raw: unknown): number {
  // Strict parse. parseInt is too lenient for a security value — it reads
  // "4abc" as 4 and "3.7" as 3, so a malformed header could grant a tier.
  // Only a pure run of digits counts; everything else falls back to 1.
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : NaN;

  // Non-integers (3.7, NaN, Infinity) fail closed rather than round.
  if (!Number.isInteger(n)) return 1;
  return Math.min(4, Math.max(1, n));
}

/**
 * Read the trusted session out of a RequestContext.
 * Fails closed: missing or malformed values degrade to the public tier
 * (prospective / trust 1 / no institution), never upward.
 */
export function getSessionContext(rc: RequestContext | undefined): SessionContext {
  if (!rc) {
    return { role: 'prospective', roles: ['prospective'], trustLevel: 1, isPlatformAdmin: false };
  }

  const institutionId = rc.get(SESSION_KEYS.institutionId);
  const userPublicId  = rc.get(SESSION_KEYS.userPublicId);
  const allowlist     = rc.get(SESSION_KEYS.namespaceAllowlist);

  const role = normalizeSessionRole(rc.get(SESSION_KEYS.role));

  return {
    role,
    roles:      normalizeSessionRoles(rc.get(SESSION_KEYS.roles), role),
    // Strict boolean: only a real `true` (or the string "true" a header carries)
    // grants it. Any other value — including a truthy string like "0" — is false.
    isPlatformAdmin:
      rc.get(SESSION_KEYS.isPlatformAdmin) === true ||
      rc.get(SESSION_KEYS.isPlatformAdmin) === 'true',
    trustLevel: clampTrustLevel(rc.get(SESSION_KEYS.trustLevel)),
    institutionId: typeof institutionId === 'string' && institutionId ? institutionId : undefined,
    userPublicId:  typeof userPublicId  === 'string' && userPublicId  ? userPublicId  : undefined,
    namespaceAllowlist:
      Array.isArray(allowlist) && allowlist.length > 0
        ? allowlist.filter((ns): ns is string => typeof ns === 'string' && ns.length > 0)
        : undefined,
  };
}
