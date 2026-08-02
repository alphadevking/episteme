// episteme-chat/lib/telemetry/latency.ts
/**
 * Latency aggregation over the telemetry the chat route already emits.
 *
 * app/api/chat/route.ts logs one line per request:
 *
 *   {"event":"ttft","req_id":"…","ttft_ms":1840,"role":"student","meets_nfr101":true}
 *   {"event":"stream_complete","req_id":"…","total_ms":7320}
 *
 * The measurement existed; the rollup did not. A per-request boolean tells you
 * nothing about whether the system meets NFR-101 — that is a question about a
 * DISTRIBUTION, and answering it needs percentiles over many requests. This
 * module turns a pile of log lines into that answer.
 *
 * Pure and dependency-free on purpose: parsing and percentile maths are exactly
 * the parts that are easy to get subtly wrong and impossible to notice, so they
 * are unit-tested (latency.test.ts) and run in the normal `pnpm test` suite.
 * The scripts that fetch logs or drive a live server are thin wrappers.
 */

export interface TtftRecord {
  reqId?: string;
  ttftMs: number;
  role?: string;
  meetsNfr101: boolean;
}

export interface CompleteRecord {
  reqId?: string;
  totalMs: number;
}

export interface ParsedLatencyLogs {
  ttft: TtftRecord[];
  complete: CompleteRecord[];
  /** Lines that looked like our telemetry but could not be used. */
  malformed: number;
}

/**
 * Extract telemetry from arbitrary log text.
 *
 * Tolerant by necessity: exported Vercel logs prefix each line with a timestamp
 * and region, so the JSON is embedded rather than alone on the line. Anything
 * that is not one of our two events is ignored silently — a log file is full of
 * other people's lines and that is not an error.
 */
export function parseLatencyLogs(text: string): ParsedLatencyLogs {
  const ttft: TtftRecord[] = [];
  const complete: CompleteRecord[] = [];
  let malformed = 0;

  for (const line of text.split(/\r?\n/)) {
    // Cheap pre-filter so we only attempt JSON parsing on candidate lines.
    if (!line.includes('"event"')) continue;

    const start = line.indexOf('{');
    const end   = line.lastIndexOf('}');
    if (start === -1 || end <= start) { malformed++; continue; }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(start, end + 1));
    } catch {
      malformed++;
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null) { malformed++; continue; }
    const obj = parsed as Record<string, unknown>;

    if (obj['event'] === 'ttft') {
      if (typeof obj['ttft_ms'] !== 'number' || !Number.isFinite(obj['ttft_ms'])) { malformed++; continue; }
      ttft.push({
        reqId:  typeof obj['req_id'] === 'string' ? obj['req_id'] : undefined,
        ttftMs: obj['ttft_ms'],
        role:   typeof obj['role'] === 'string' ? obj['role'] : undefined,
        // Derived from the number rather than trusting the logged boolean: the
        // threshold is the definition of NFR-101, and a stale deployment logging
        // an old threshold must not skew the rollup.
        meetsNfr101: obj['ttft_ms'] < NFR_101_TTFT_MS,
      });
    } else if (obj['event'] === 'stream_complete') {
      if (typeof obj['total_ms'] !== 'number' || !Number.isFinite(obj['total_ms'])) { malformed++; continue; }
      complete.push({
        reqId:   typeof obj['req_id'] === 'string' ? obj['req_id'] : undefined,
        totalMs: obj['total_ms'],
      });
    }
  }

  return { ttft, complete, malformed };
}

/** NFR-101: time to first token must be under 2 seconds. */
export const NFR_101_TTFT_MS = 2000;

/**
 * Nearest-rank percentile: the smallest value at or below which at least p% of
 * observations fall. p95 of 20 samples is the 19th sorted value.
 *
 * Chosen over interpolation because it always returns a value that was actually
 * measured — for latency SLOs, "a real request took this long" is easier to
 * defend than an interpolated figure no request ever exhibited.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index]!;
}

export interface Distribution {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function describe(values: number[]): Distribution {
  if (values.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min:   sorted[0]!,
    p50:   percentile(sorted, 50),
    p95:   percentile(sorted, 95),
    p99:   percentile(sorted, 99),
    max:   sorted[sorted.length - 1]!,
    mean:  sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

export interface LatencySummary {
  ttft: Distribution;
  total: Distribution;
  /** Fraction of requests meeting NFR-101, or null when there is no data. */
  nfr101PassRate: number | null;
  byRole: Record<string, Distribution>;
  malformed: number;
}

export function summarizeLatency(logs: ParsedLatencyLogs): LatencySummary {
  const ttftValues = logs.ttft.map((r) => r.ttftMs);

  const byRole: Record<string, number[]> = {};
  for (const record of logs.ttft) {
    const role = record.role ?? 'unknown';
    (byRole[role] ??= []).push(record.ttftMs);
  }

  return {
    ttft:  describe(ttftValues),
    total: describe(logs.complete.map((r) => r.totalMs)),
    nfr101PassRate: ttftValues.length === 0
      ? null
      : logs.ttft.filter((r) => r.meetsNfr101).length / ttftValues.length,
    byRole: Object.fromEntries(
      Object.entries(byRole).map(([role, values]) => [role, describe(values)]),
    ),
    malformed: logs.malformed,
  };
}

const ms = (n: number) => `${Math.round(n)}ms`;

/** Fixed-width report. Reads the same from a script, a log drain, or CI. */
export function formatLatencySummary(summary: LatencySummary): string {
  const lines: string[] = [];
  const row = (label: string, d: Distribution) =>
    `  ${label.padEnd(12)} n=${String(d.count).padEnd(6)} ` +
    `p50=${ms(d.p50).padEnd(8)} p95=${ms(d.p95).padEnd(8)} p99=${ms(d.p99).padEnd(8)} max=${ms(d.max)}`;

  lines.push('Latency');
  lines.push(row('TTFT', summary.ttft));
  lines.push(row('total', summary.total));

  if (summary.nfr101PassRate === null) {
    lines.push('\n  NFR-101 (TTFT < 2000ms): no data');
  } else {
    const pass = summary.nfr101PassRate;
    lines.push(
      `\n  NFR-101 (TTFT < ${NFR_101_TTFT_MS}ms): ${(pass * 100).toFixed(1)}% of ` +
      `${summary.ttft.count} requests` + (pass < 0.95 ? '   ← below a 95% target' : ''),
    );
  }

  const roles = Object.keys(summary.byRole).sort();
  if (roles.length > 0) {
    lines.push('\n  TTFT by role');
    for (const role of roles) lines.push(row(`  ${role}`, summary.byRole[role]!));
  }

  if (summary.malformed > 0) {
    lines.push(`\n  ${summary.malformed} telemetry-looking line(s) could not be parsed`);
  }

  return lines.join('\n');
}
