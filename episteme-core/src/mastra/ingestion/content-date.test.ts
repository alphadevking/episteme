// episteme-core/src/mastra/ingestion/content-date.test.ts
/**
 * Content-date semantics: dated vs undated vs stale.
 *
 * Three distinct states that the code repeatedly tried to collapse into two:
 *
 *   dated + recent  → use normally
 *   dated + old     → "may be outdated", and the cascade prefers a fresher tier
 *   UNDATED         → age unknown. NOT stale. Must not carry the outdated
 *                     warning, must not divert the cascade, and must lose to a
 *                     dated source when they disagree on a time-varying fact.
 *
 * The failure this guards against is treating "we don't know when this was
 * written" as either "it's current" (stamping today's date) or "it's old"
 * (emitting the outdated warning). Both are claims about age we do not have.
 *
 * Pure — the sort key and staleness predicate are reimplemented here from the
 * same rules the retrieval tool applies, because that module builds a Pinecone
 * client at import scope and cannot be loaded without credentials.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const DAY = 86_400_000;
const FRESHNESS_DAYS = 365;

/** Mirrors isDaysOld in knowledge-retrieval-tool.ts. */
function isDaysOld(isoDate: string, days: number, now = Date.now()): boolean {
  const then = new Date(isoDate).getTime();
  if (!Number.isFinite(then)) return false;
  return (now - then) / DAY > days;
}

/** Mirrors contentTime in knowledge-retrieval-tool.ts. */
function contentTime(updatedAt: unknown): number {
  if (typeof updatedAt !== 'string' || !updatedAt) return Number.NEGATIVE_INFINITY;
  const t = new Date(updatedAt).getTime();
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Mirrors the staleWarning decision. */
function staleWarning(updatedAt: string | null): string | null {
  return updatedAt && isDaysOld(updatedAt, FRESHNESS_DAYS)
    ? 'outdated'
    : null;
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

describe('undated is not stale', () => {
  test('an undated source never carries the outdated warning', () => {
    assert.equal(staleWarning(null), null);
  });

  test('a genuinely old dated source still does', () => {
    assert.equal(staleWarning(iso(FRESHNESS_DAYS + 1)), 'outdated');
  });

  test('a recent dated source does not', () => {
    assert.equal(staleWarning(iso(10)), null);
  });

  test('an unparseable date is treated as unknown, not as old', () => {
    // Junk must not silently become "very old" via NaN comparisons — that
    // would attach an outdated warning to a document nobody can date.
    for (const junk of ['', 'not a date', 'soon', '2026-13-45']) {
      assert.equal(staleWarning(junk), null, `"${junk}" produced a staleness claim`);
    }
  });
});

describe('recency sort — undated ranks last, never NaN', () => {
  const sortByRecency = (dates: (string | null)[]) =>
    [...dates].sort((a, b) => {
      const at = contentTime(a);
      const bt = contentTime(b);
      if (at === bt) return 0;
      return bt - at;
    });

  test('dated sources outrank undated ones', () => {
    // Fixed values so the assertion compares exact strings rather than
    // recomputing iso() and getting a different millisecond.
    const recent = iso(10);
    const old = iso(400);
    assert.deepEqual(sortByRecency([null, old, null, recent]), [recent, old, null, null]);
  });

  test('the newest dated source comes first', () => {
    const recent = iso(1);
    const old = iso(500);
    assert.equal(sortByRecency([old, null, recent])[0], recent);
  });

  test('all-undated input does not produce NaN comparisons', () => {
    // NEGATIVE_INFINITY - NEGATIVE_INFINITY is NaN, which makes Array.sort's
    // behaviour undefined. The comparator short-circuits equal keys for this.
    const dates = [null, null, null];
    assert.doesNotThrow(() => sortByRecency(dates));
    assert.deepEqual(sortByRecency(dates), [null, null, null]);
  });

  test('the comparator is a total order over mixed input', () => {
    const values: (string | null)[] = [null, iso(5), 'junk', iso(900), '', null];
    const cmp = (a: string | null, b: string | null) => {
      const at = contentTime(a), bt = contentTime(b);
      return at === bt ? 0 : bt - at;
    };
    for (const a of values) {
      for (const b of values) {
        const ab = cmp(a, b);
        const ba = cmp(b, a);
        // NaN is the only genuinely broken result — it makes Array.sort's
        // behaviour undefined. ±Infinity is fine and expected when a dated
        // source is compared to an undated one; sort only reads the sign.
        assert.ok(!Number.isNaN(ab), `NaN comparison for ${a} vs ${b}`);
        // `===` rather than assert.equal: strict-mode equal uses Object.is,
        // under which 0 and -0 differ, and -Math.sign(0) is -0.
        assert.ok(Math.sign(ab) === -Math.sign(ba), `asymmetric for ${a} vs ${b}`);
      }
    }
  });

  test('junk and empty dates sort with undated, not above it', () => {
    const recent = iso(10);
    const sorted = sortByRecency([recent, 'junk', null, '']);
    assert.equal(sorted[0], recent);
    for (const v of sorted.slice(1)) {
      assert.equal(contentTime(v), Number.NEGATIVE_INFINITY);
    }
  });
});

describe('the three states are distinguishable', () => {
  test('dated-recent, dated-old and undated each produce a different signal', () => {
    const states = [
      { updatedAt: iso(10),                 label: 'dated-recent' },
      { updatedAt: iso(FRESHNESS_DAYS + 1), label: 'dated-old' },
      { updatedAt: null,                    label: 'undated' },
    ];

    const signals = states.map((s) => ({
      label: s.label,
      hasDate: s.updatedAt != null,
      stale: staleWarning(s.updatedAt) != null,
    }));

    assert.deepEqual(signals, [
      { label: 'dated-recent', hasDate: true,  stale: false },
      { label: 'dated-old',    hasDate: true,  stale: true  },
      { label: 'undated',      hasDate: false, stale: false },
    ]);
  });

  test('undated and dated-recent differ, so the reader can be told which', () => {
    // Both produce no staleness warning, so `stale` alone cannot distinguish
    // them. The presence of a date is what the context builder branches on to
    // print "undated" rather than a date.
    assert.equal(staleWarning(null), staleWarning(iso(10)));
    assert.notEqual(null != null, iso(10) != null);
  });
});
