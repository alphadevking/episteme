// episteme-core/src/mastra/server/chat-security.ts
/**
 * Chat security middleware — authenticates the episteme-chat proxy and injects
 * the trusted session context into Mastra's RequestContext.
 *
 * Why middleware and not tool inputs:
 *   Mastra's built-in setup middleware populates RequestContext from the request
 *   BODY (client-controlled), and LLM tool arguments are model-controlled. Both
 *   are forgeable. This middleware runs after the setup middleware and before
 *   the /chat route, so it can (a) reject callers that don't present the shared
 *   secret and (b) unconditionally overwrite every session key from the
 *   x-episteme-* headers — which only the authenticated Next.js proxy sets,
 *   after validating the Supabase session server-side.
 *
 * Header contract (all set by episteme-chat/app/api/chat/route.ts):
 *   x-episteme-admin-key            shared secret (MASTRA_ADMIN_KEY)
 *   x-episteme-role                 retrieval role (prospective|student|parent|staff|hod)
 *   x-episteme-roles                comma-separated full role set (omitted → [role])
 *   x-episteme-trust-level          1–4
 *   x-episteme-institution-id       institution UUID (omitted → global docs only)
 *   x-episteme-user-public-id       users.id UUID (omitted → claim lookups refused)
 *   x-episteme-namespace-allowlist  comma-separated (parents only)
 *   x-episteme-platform-admin       "true" iff the app role is admin/superadmin
 */
import type { ContextWithMastra } from '@mastra/core/server';
import { RequestContext } from '@mastra/core/request-context';
import { SESSION_KEYS, normalizeSessionRole, normalizeSessionRoles, clampTrustLevel } from './session-context';

declare const process: { env: Record<string, string | undefined> };

type Next = () => Promise<void>;

export const chatSecurityMiddleware = {
  path: '/chat/*',
  handler: async (c: ContextWithMastra, next: Next) => {
    const adminKey = process.env['MASTRA_ADMIN_KEY'];
    if (!adminKey || c.req.header('x-episteme-admin-key') !== adminKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const rc = c.get('requestContext') ?? new RequestContext();
    c.set('requestContext', rc);

    // Overwrite unconditionally — values already present may originate from the
    // request body. Absent headers must clear the key, not inherit it.
    const setOrClear = (key: string, value: unknown) => {
      if (value === undefined) rc.delete(key);
      else rc.set(key, value);
    };

    const role = normalizeSessionRole(c.req.header('x-episteme-role'));
    rc.set(SESSION_KEYS.role,       role);
    // Absent x-episteme-roles → [role], i.e. exactly the previous behaviour.
    // This is what lets core and chat deploy independently, in either order.
    rc.set(SESSION_KEYS.roles,      normalizeSessionRoles(c.req.header('x-episteme-roles'), role));
    rc.set(SESSION_KEYS.trustLevel, clampTrustLevel(c.req.header('x-episteme-trust-level')));
    // Strict equality — a missing or any-other-value header is false.
    rc.set(SESSION_KEYS.isPlatformAdmin, c.req.header('x-episteme-platform-admin') === 'true');
    setOrClear(SESSION_KEYS.institutionId, c.req.header('x-episteme-institution-id') || undefined);
    setOrClear(SESSION_KEYS.userPublicId,  c.req.header('x-episteme-user-public-id') || undefined);

    const allowlistRaw = c.req.header('x-episteme-namespace-allowlist');
    const allowlist = allowlistRaw
      ? allowlistRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    setOrClear(SESSION_KEYS.namespaceAllowlist, allowlist);

    await next();
  },
};
