// episteme-core/src/mastra/server/on-error.ts
/**
 * Error reporting for the server's onError hook.
 *
 * Mastra's default handler in production is:
 *
 *   logger.error(err);
 *   return c.json({ error: "Internal Server Error" }, 500);
 *
 * The body is a fixed string, so the chat proxy's `details` passthrough carried
 * nothing, and the log line was the only copy of the error. During the
 * 2026-08-01 outage that copy had also been stripped by log redaction, leaving
 * a 500 with no attributable cause anywhere — three round trips of guesswork.
 *
 * The response stays opaque (no internals reach the client) but is stamped with
 * a correlation id that also appears in the log line, so any report of "I got a
 * 500" maps to one exact stack in one grep.
 *
 * Everything here is Hono-free on purpose: Mastra bundles its own copy of
 * Hono's types, so a `Context` imported from the app's `hono` is not assignable
 * to the one its ServerConfig expects. The adapter that touches the context is
 * three lines inlined in index.ts, where TS types it contextually; the parts
 * worth testing live here as pure functions.
 */

/** Error shape after JSON-ification: message, stack, and the full cause chain. */
export function describeError(err: unknown, depth = 0): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) };
  const e = err as Error & { code?: unknown; cause?: unknown; id?: unknown };
  return {
    name: e.name,
    message: e.message,
    ...(e.code !== undefined ? { code: e.code } : {}),
    // MastraError carries a stable id (e.g. MASTRA_STORAGE_LIBSQL_CREATE_TABLE_FAILED)
    // that is far more greppable than the message.
    ...(typeof e.id === 'string' ? { id: e.id } : {}),
    ...(e.stack ? { stack: e.stack } : {}),
    // Depth-capped: cause chains from wrapped fetch errors can be deep or cyclic.
    ...(e.cause && depth < 4 ? { cause: describeError(e.cause, depth + 1) } : {}),
  };
}

/**
 * Hono's HTTPException, identified structurally rather than by `instanceof`.
 *
 * The dual-Hono situation above means `instanceof HTTPException` can be false
 * for an exception thrown inside Mastra's bundled copy. Getting this wrong
 * would turn a deliberate 404 or 413 into a 500, so it is duck-typed.
 */
export function httpExceptionStatus(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const e = err as Error & { status?: unknown; getResponse?: unknown };
  return typeof e.status === 'number' && typeof e.getResponse === 'function'
    ? e.status
    : undefined;
}

export interface ErrorReport {
  correlationId: string;
  logPayload: Record<string, unknown>;
  body: { error: string; correlationId: string };
}

/** Builds the log payload and the client-facing body for an unhandled error. */
export function buildErrorReport(err: unknown, method: string, path: string): ErrorReport {
  const correlationId = crypto.randomUUID();
  return {
    correlationId,
    logPayload: { correlationId, method, path, error: describeError(err) },
    body: { error: 'Internal Server Error', correlationId },
  };
}
