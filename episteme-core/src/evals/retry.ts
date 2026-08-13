// episteme-core/src/evals/retry.ts
/**
 * Rate-limit resilience for the eval runners.
 *
 * WHY THIS EXISTS. Mistral enforces 50,000 tokens per minute. Across four
 * prompt-eval runs it dropped cases in three of them — 3, 3, 0 and 5 — and the
 * cases it dropped differed each time. The provider says plainly that the error
 * is recoverable:
 *
 *   "statusCode": 429, "isRetryable": true, "type": "rate_limited"
 *
 * The runner ignored that and recorded EXECUTION ERROR, so a case that was never
 * asked became indistinguishable at a glance from a case that answered badly.
 * That is a measurement failure, not a property of the system under test, and it
 * left `multi-role-keeps-student-access` — an access-control case — unexecuted
 * across three consecutive runs.
 *
 * Everything here is pure apart from the sleep, which is injected so the tests
 * exercise the backoff schedule without spending two minutes doing it.
 */

/**
 * Backoff schedule, in milliseconds.
 *
 * Tuned to the shape of the limit rather than to a generic exponential curve:
 * the bucket is PER MINUTE, so the final delay deliberately clears a 60-second
 * boundary from the first failure. A 1s/2s/4s ladder would burn all its
 * attempts inside the same exhausted window and fail anyway.
 */
export const RATE_LIMIT_DELAYS_MS = [20_000, 45_000, 70_000] as const;

/**
 * Whether an error is a provider rate limit.
 *
 * Deliberately narrow. Retrying an ordinary bug costs minutes of wall clock and
 * buries the real stack trace under repeats, so anything not recognisably a
 * rate limit must fail fast and loudly.
 */
export function isRateLimitError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;

  if (e['statusCode'] === 429 || e['status'] === 429) return true;

  const data = e['data'];
  if (data != null && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (d['type'] === 'rate_limited') return true;
    if (typeof d['message'] === 'string' && /rate limit/i.test(d['message'])) return true;
  }

  // Last resort: some SDK layers flatten the payload into the message and drop
  // the status code. Matched narrowly so a message merely mentioning limits in
  // passing does not trigger a retry storm.
  const message = typeof e['message'] === 'string' ? e['message'] : '';
  return /\brate.?limit(ed)?\b/i.test(message) || /\b429\b/.test(message);
}

export interface RetryOptions {
  /** Delay before each retry. Length determines the retry count. */
  delaysMs?: readonly number[];
  /** Which errors are worth retrying. Defaults to rate limits only. */
  isRetryable?: (err: unknown) => boolean;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, for run-log visibility. */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying on retryable failures along the given backoff schedule.
 *
 * Rethrows the LAST error once attempts are exhausted, so an eval that still
 * cannot get through reports the provider's own message rather than a wrapper
 * that hides it.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delays      = options.delaysMs   ?? RATE_LIMIT_DELAYS_MS;
  const isRetryable = options.isRetryable ?? isRateLimitError;
  const sleep       = options.sleep       ?? realSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === delays.length || !isRetryable(err)) throw err;
      const delayMs = delays[attempt]!;
      options.onRetry?.(attempt + 1, delayMs, err);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Worst-case wall clock a single item can spend waiting, used to size the
 * experiment's item timeout. A timeout shorter than the backoff schedule would
 * cancel the very retry the schedule exists to perform — reintroducing the
 * dropped case by a different route.
 */
export function totalBackoffMs(delaysMs: readonly number[] = RATE_LIMIT_DELAYS_MS): number {
  return delaysMs.reduce((sum, d) => sum + d, 0);
}
