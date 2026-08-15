// episteme-core/src/evals/retry.test.ts
/**
 * The sleep is injected throughout, so these assert the backoff SCHEDULE and
 * the retry PREDICATE without spending the two minutes a real run would.
 *
 * The predicate matters as much as the loop: retrying an ordinary bug costs
 * minutes of wall clock and buries the real stack trace under repeats, so the
 * negative cases below are load-bearing.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATE_LIMIT_DELAYS_MS,
  isRateLimitError,
  totalBackoffMs,
  withRetry,
} from './retry';

/** The error shape Mistral actually returned, trimmed to what the code reads. */
const mistral429 = {
  name: 'AI_APICallError',
  statusCode: 429,
  isRetryable: true,
  data: { message: 'Rate limit exceeded', type: 'rate_limited', code: '1300' },
};

describe('isRateLimitError', () => {
  test('recognises the real Mistral 429 payload', () => {
    assert.equal(isRateLimitError(mistral429), true);
  });

  test('recognises a bare 429 status', () => {
    assert.equal(isRateLimitError({ statusCode: 429 }), true);
    assert.equal(isRateLimitError({ status: 429 }), true);
  });

  test('recognises the typed payload without a status code', () => {
    assert.equal(isRateLimitError({ data: { type: 'rate_limited' } }), true);
  });

  test('recognises a flattened message', () => {
    assert.equal(isRateLimitError(new Error('Rate limit exceeded')), true);
    assert.equal(isRateLimitError(new Error('request failed with 429')), true);
  });

  // Negative cases: these must fail FAST. A retry here wastes minutes and hides
  // the stack trace that would have explained the failure.
  test('does not retry ordinary failures', () => {
    assert.equal(isRateLimitError(new Error('Cannot read property of undefined')), false);
    assert.equal(isRateLimitError({ statusCode: 500 }), false);
    assert.equal(isRateLimitError({ statusCode: 401 }), false);
    assert.equal(isRateLimitError(null), false);
    assert.equal(isRateLimitError(undefined), false);
    assert.equal(isRateLimitError('rate limit'), false, 'a bare string is not an error object');
  });

  test('does not retry a message that merely mentions limits', () => {
    assert.equal(isRateLimitError(new Error('the token limit for this model is 8192')), false);
  });
});

describe('withRetry', () => {
  const collectSleeps = () => {
    const slept: number[] = [];
    return { slept, sleep: async (ms: number) => { slept.push(ms); } };
  };

  test('returns immediately when the call succeeds', async () => {
    const { slept, sleep } = collectSleeps();
    let calls = 0;
    const out = await withRetry(async () => { calls++; return 'ok'; }, { sleep });
    assert.equal(out, 'ok');
    assert.equal(calls, 1);
    assert.deepEqual(slept, []);
  });

  test('recovers when a rate limit clears on a later attempt', async () => {
    const { slept, sleep } = collectSleeps();
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls < 3) throw mistral429;
      return 'recovered';
    }, { sleep });

    assert.equal(out, 'recovered');
    assert.equal(calls, 3);
    assert.deepEqual(slept, [RATE_LIMIT_DELAYS_MS[0], RATE_LIMIT_DELAYS_MS[1]]);
  });

  test('the final delay clears a one-minute window', () => {
    // The bucket refills per minute, so the last attempt must land in a new one.
    // An exponential ladder would spend every attempt inside the same exhausted
    // window and fail regardless.
    assert.ok(
      RATE_LIMIT_DELAYS_MS[RATE_LIMIT_DELAYS_MS.length - 1]! > 60_000,
      `final delay ${RATE_LIMIT_DELAYS_MS.at(-1)}ms does not clear 60s`,
    );
  });

  test('rethrows the provider error once attempts are exhausted', async () => {
    const { slept, sleep } = collectSleeps();
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw mistral429; }, { sleep }),
      (err: unknown) => err === mistral429,
    );
    assert.equal(calls, RATE_LIMIT_DELAYS_MS.length + 1, 'one initial attempt plus one per delay');
    assert.equal(slept.length, RATE_LIMIT_DELAYS_MS.length);
  });

  test('a non-retryable error fails on the first attempt', async () => {
    const { slept, sleep } = collectSleeps();
    let calls = 0;
    const bug = new Error('genuine bug');
    await assert.rejects(
      withRetry(async () => { calls++; throw bug; }, { sleep }),
      (err: unknown) => err === bug,
    );
    assert.equal(calls, 1);
    assert.deepEqual(slept, [], 'no time wasted sleeping on a real failure');
  });

  test('onRetry reports each wait for the run log', async () => {
    const { sleep } = collectSleeps();
    const seen: Array<{ attempt: number; delayMs: number }> = [];
    await withRetry(async () => { throw mistral429; }, {
      delaysMs: [10, 20],
      sleep,
      onRetry: (attempt, delayMs) => seen.push({ attempt, delayMs }),
    }).catch(() => {});
    assert.deepEqual(seen, [
      { attempt: 1, delayMs: 10 },
      { attempt: 2, delayMs: 20 },
    ]);
  });

  test('an empty schedule disables retrying', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw mistral429; }, { delaysMs: [], sleep: async () => {} }),
    );
    assert.equal(calls, 1);
  });
});

describe('totalBackoffMs', () => {
  test('sums the schedule so the item timeout can be sized from it', () => {
    // A timeout shorter than the backoff would cancel the retry the backoff
    // exists to perform, reintroducing the dropped case by another route.
    assert.equal(totalBackoffMs([1000, 2000, 3000]), 6000);
    assert.equal(totalBackoffMs(), 135_000);
  });
});
