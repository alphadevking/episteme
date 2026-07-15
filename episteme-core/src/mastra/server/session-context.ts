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
  trustLevel:         'episteme.trustLevel',
  institutionId:      'episteme.institutionId',
  userPublicId:       'episteme.userPublicId',
  namespaceAllowlist: 'episteme.namespaceAllowlist',
} as const;

/** Retrieval role space — matches ROLE_NAMESPACES in knowledge-retrieval-tool. */
export const SESSION_ROLES = ['prospective', 'student', 'parent', 'staff', 'hod'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

export interface SessionContext {
  role: SessionRole;
  /** 1–4, hard-clamped. 1 = public-only. */
  trustLevel: number;
  institutionId?: string;
  userPublicId?: string;
  /** Explicit namespace allowlist for parent users (link permissions). */
  namespaceAllowlist?: string[];
}

export function normalizeSessionRole(raw: unknown): SessionRole {
  return SESSION_ROLES.includes(raw as SessionRole) ? (raw as SessionRole) : 'prospective';
}

export function clampTrustLevel(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(n)) return 1;
  return Math.min(4, Math.max(1, n));
}

/**
 * Read the trusted session out of a RequestContext.
 * Fails closed: missing or malformed values degrade to the public tier
 * (prospective / trust 1 / no institution), never upward.
 */
export function getSessionContext(rc: RequestContext | undefined): SessionContext {
  if (!rc) return { role: 'prospective', trustLevel: 1 };

  const institutionId = rc.get(SESSION_KEYS.institutionId);
  const userPublicId  = rc.get(SESSION_KEYS.userPublicId);
  const allowlist     = rc.get(SESSION_KEYS.namespaceAllowlist);

  return {
    role:       normalizeSessionRole(rc.get(SESSION_KEYS.role)),
    trustLevel: clampTrustLevel(rc.get(SESSION_KEYS.trustLevel)),
    institutionId: typeof institutionId === 'string' && institutionId ? institutionId : undefined,
    userPublicId:  typeof userPublicId  === 'string' && userPublicId  ? userPublicId  : undefined,
    namespaceAllowlist:
      Array.isArray(allowlist) && allowlist.length > 0
        ? allowlist.filter((ns): ns is string => typeof ns === 'string' && ns.length > 0)
        : undefined,
  };
}
