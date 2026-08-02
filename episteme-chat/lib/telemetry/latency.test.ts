// episteme-chat/lib/telemetry/latency.test.ts
/**
 * Unit tests for latency aggregation.
 *
 * These run with no server and no network. The percentile maths and the log
 * parsing are where this kind of code goes quietly wrong — an off-by-one in a
 * percentile or a silently-dropped log line produces a plausible number that
 * nobody can tell is false, which is worse than no number at all.
 */
import { test, describe as suite } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLatencyLogs,
  percentile,
  describe,
  summarizeLatency,
  formatLatencySummary,
  NFR_101_TTFT_MS,
} from './latency';

suite('percentile', () => {
  test('nearest-rank returns a value that was actually observed', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(percentile(values, 50), 50);
    assert.equal(percentile(values, 95), 100);
    assert.equal(percentile(values, 100), 100);
  });

  test('p95 of 20 samples is the 19th sorted value', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.equal(percentile(values, 95), 19);
  });

  test('unsorted input is handled', () => {
    assert.equal(percentile([50, 10, 30], 50), 30);
  });

  test('single sample is every percentile', () => {
    assert.equal(percentile([42], 50), 42);
    assert.equal(percentile([42], 99), 42);
  });

  test('empty input is 0, not NaN', () => {
    assert.equal(percentile([], 95), 0);
  });

  test('does not mutate its input', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    assert.deepEqual(values, [3, 1, 2]);
  });
});

suite('parseLatencyLogs', () => {
  test('extracts both event types from bare JSON lines', () => {
    const text = [
      '{"event":"ttft","req_id":"a","ttft_ms":1500,"role":"student","meets_nfr101":true}',
      '{"event":"stream_complete","req_id":"a","total_ms":6000}',
    ].join('\n');

    const parsed = parseLatencyLogs(text);
    assert.equal(parsed.ttft.length, 1);
    assert.equal(parsed.complete.length, 1);
    assert.equal(parsed.ttft[0]!.ttftMs, 1500);
    assert.equal(parsed.ttft[0]!.role, 'student');
    assert.equal(parsed.complete[0]!.totalMs, 6000);
    assert.equal(parsed.malformed, 0);
  });

  /**
   * Exported Vercel logs prefix each line with a timestamp and region, so the
   * JSON is embedded. Requiring a bare line would silently parse nothing and
   * report a confident zero.
   */
  test('extracts JSON embedded in a prefixed log line', () => {
    const text =
      '2026-08-01T20:35:35.699Z [info] iad1 {"event":"ttft","ttft_ms":1234,"role":"staff","meets_nfr101":true}';
    const parsed = parseLatencyLogs(text);
    assert.equal(parsed.ttft.length, 1);
    assert.equal(parsed.ttft[0]!.ttftMs, 1234);
  });

  test('ignores unrelated lines without counting them as malformed', () => {
    const text = [
      'GET /api/chat 200',
      '{"event":"mastra_upstream_error","upstream_status":500}',
      '{"event":"ttft","ttft_ms":900,"meets_nfr101":true}',
    ].join('\n');
    const parsed = parseLatencyLogs(text);
    assert.equal(parsed.ttft.length, 1);
    assert.equal(parsed.malformed, 0);
  });

  test('counts telemetry-looking lines it cannot use', () => {
    const text = [
      '{"event":"ttft","ttft_ms":"not-a-number"}',
      '{"event":"ttft" broken json',
    ].join('\n');
    const parsed = parseLatencyLogs(text);
    assert.equal(parsed.ttft.length, 0);
    assert.equal(parsed.malformed, 2);
  });

  /**
   * The pass flag is recomputed from the number rather than trusted from the
   * log, so a deployment still logging an older threshold cannot skew the
   * rollup. This line claims to pass while exceeding the threshold.
   */
  test('recomputes NFR-101 rather than trusting the logged flag', () => {
    const text = `{"event":"ttft","ttft_ms":${NFR_101_TTFT_MS + 500},"meets_nfr101":true}`;
    const parsed = parseLatencyLogs(text);
    assert.equal(parsed.ttft[0]!.meetsNfr101, false);
  });
});

suite('summarizeLatency', () => {
  const logs = parseLatencyLogs([
    '{"event":"ttft","ttft_ms":1000,"role":"student","meets_nfr101":true}',
    '{"event":"ttft","ttft_ms":1900,"role":"student","meets_nfr101":true}',
    '{"event":"ttft","ttft_ms":2500,"role":"staff","meets_nfr101":false}',
    '{"event":"ttft","ttft_ms":3000,"role":"staff","meets_nfr101":false}',
    '{"event":"stream_complete","total_ms":8000}',
  ].join('\n'));

  test('computes the NFR-101 pass rate across requests', () => {
    const summary = summarizeLatency(logs);
    assert.equal(summary.ttft.count, 4);
    assert.equal(summary.nfr101PassRate, 0.5);
  });

  test('breaks TTFT down by role', () => {
    const summary = summarizeLatency(logs);
    assert.equal(summary.byRole['student']!.count, 2);
    assert.equal(summary.byRole['staff']!.count, 2);
    assert.equal(summary.byRole['student']!.max, 1900);
  });

  test('reports null pass rate rather than a misleading 0% when there is no data', () => {
    const summary = summarizeLatency(parseLatencyLogs(''));
    assert.equal(summary.nfr101PassRate, null);
    assert.equal(summary.ttft.count, 0);
  });

  test('groups records with no role under "unknown"', () => {
    const summary = summarizeLatency(parseLatencyLogs('{"event":"ttft","ttft_ms":500}'));
    assert.equal(summary.byRole['unknown']!.count, 1);
  });

  test('formats without throwing on empty input', () => {
    const text = formatLatencySummary(summarizeLatency(parseLatencyLogs('')));
    assert.match(text, /no data/);
  });
});

suite('describe', () => {
  test('reports min, max and mean alongside percentiles', () => {
    const d = describe([100, 200, 300]);
    assert.equal(d.min, 100);
    assert.equal(d.max, 300);
    assert.equal(d.mean, 200);
    assert.equal(d.count, 3);
  });
});
