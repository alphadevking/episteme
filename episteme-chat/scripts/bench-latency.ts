// episteme-chat/scripts/bench-latency.ts
/**
 * Live latency benchmark against the Mastra chat endpoint.
 *
 *   pnpm bench:latency                  # 3 runs of the default query set
 *   pnpm bench:latency --runs 5         # more samples per query
 *   pnpm bench:latency --concurrency 2  # overlap requests
 *
 * Measures what a user actually waits for: time to FIRST token, and total time
 * until the stream closes. It talks to episteme-core directly with the admin
 * key and synthetic session headers — the same contract app/api/chat/route.ts
 * uses — so it needs no browser session and no Supabase login.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST: every run costs real model and retrieval
 * calls, and the numbers move with provider load. Gating CI on it would produce
 * a flaky suite that measures Mistral's day rather than our code. The pure
 * aggregation it prints through IS unit-tested (lib/telemetry/latency.test.ts).
 *
 * READ-ONLY with respect to your data: it asks questions, it ingests nothing.
 * It does consume model tokens — that is the cost of measuring the real thing.
 */
import {
  carriesText,
  describe as describeDistribution,
  formatLatencySummary,
  summarizeLatency,
  type ParsedLatencyLogs,
} from '../lib/telemetry/latency';

const BASE_URL  = process.env.MASTRA_BASE_URL ?? 'http://localhost:4111';
const AGENT_ID  = process.env.MASTRA_AGENT_ID ?? 'episteme-chat-agent';
const ADMIN_KEY = process.env.MASTRA_ADMIN_KEY;

/**
 * A fixed, representative set. Mixed deliberately: a KB lookup, a platform
 * question, a news-shaped query, and an out-of-domain one that should abstain
 * quickly. Averaging only over easy queries would report a latency the real
 * traffic never sees.
 */
const QUERIES = [
  { q: 'how do I apply for hostel accommodation',        role: 'student',     trust: 2 },
  { q: 'what are the admission requirements',            role: 'prospective', trust: 1 },
  { q: 'how do I add a document to the knowledge base',  role: 'staff',       trust: 4 },
  { q: 'what is the capital of France',                  role: 'student',     trust: 2 },
];

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const RUNS        = arg('runs', 3);
const CONCURRENCY = arg('concurrency', 1);

interface Sample {
  query: string;
  role: string;
  ttftMs: number;
  totalMs: number;
  ok: boolean;
  /** Reads that delivered bytes. 1 means the whole body arrived in one piece. */
  chunks: number;
  /** Whether a frame carrying generated text was ever identified. */
  streamed: boolean;
}

async function measure(query: string, role: string, trust: number): Promise<Sample> {
  const started = Date.now();
  let ttftMs = -1;
  let chunks = 0;

  const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/${encodeURIComponent(AGENT_ID)}`, {
    method: 'POST',
    headers: {
      'Content-Type':           'application/json',
      'x-episteme-admin-key':   ADMIN_KEY!,
      'x-episteme-role':        role,
      'x-episteme-roles':       role,
      'x-episteme-trust-level': String(trust),
    },
    body: JSON.stringify({
      messages: [{ role: 'user', parts: [{ type: 'text', text: query }] }],
      system:   `role=${role}`,
    }),
  });

  if (!res.ok || !res.body) {
    const elapsed = Date.now() - started;
    return { query, role, ttftMs: elapsed, totalMs: elapsed, ok: false, chunks: 0, streamed: false };
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Read to completion, timing the first CONTENT frame rather than the first
  // read. Whole lines only: a frame split across a chunk boundary will not parse,
  // and treating that as "no content yet" would push TTFT artificially later.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;

    chunks++;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    if (ttftMs === -1 && lines.some(carriesText)) ttftMs = Date.now() - started;
  }

  buffer += decoder.decode();
  if (ttftMs === -1 && buffer.split('\n').some(carriesText)) ttftMs = Date.now() - started;

  const totalMs  = Date.now() - started;
  const streamed = ttftMs !== -1;

  // No identifiable content frame — the endpoint buffered the whole body, or it
  // speaks a protocol this script does not know. Either way TTFT is unmeasurable
  // here, so report the honest value and let the caller flag it. Publishing the
  // first-read time instead is what produced the misleading 2026-08-13 production
  // figures, where TTFT sat within 4ms of total on all 20 requests.
  return { query, role, ttftMs: streamed ? ttftMs : totalMs, totalMs, ok: true, chunks, streamed };
}

/** Runs tasks with a fixed concurrency cap — same shape as the embedder's. */
async function withConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function main() {
  if (!ADMIN_KEY) {
    console.error(
      'MASTRA_ADMIN_KEY is not set — cannot authenticate to the chat endpoint.\n' +
      'Run with: node --env-file=.env.local --import tsx scripts/bench-latency.ts',
    );
    process.exit(2);
  }

  console.log(`Benchmarking ${BASE_URL} — ${QUERIES.length} queries x ${RUNS} runs, concurrency ${CONCURRENCY}\n`);

  const tasks = Array.from({ length: RUNS }).flatMap(() =>
    QUERIES.map(({ q, role, trust }) => () => measure(q, role, trust)),
  );

  const samples = await withConcurrency(tasks, CONCURRENCY);
  const ok = samples.filter((s) => s.ok);
  const failed = samples.length - ok.length;

  for (const s of ok) {
    const mark = s.streamed ? '' : '   ← not streamed';
    console.log(`  ${String(s.ttftMs).padStart(6)}ms ttft  ${String(s.totalMs).padStart(6)}ms total  [${s.role}] ${s.query}${mark}`);
  }
  if (failed > 0) console.log(`\n  ${failed} request(s) failed — excluded from the distribution.`);

  // VALIDITY GATE. A TTFT number is only a time-to-first-token if the response
  // actually streamed. Say so loudly rather than letting a buffered response be
  // written up as if it met a first-token target.
  const buffered = ok.filter((s) => !s.streamed);
  if (buffered.length > 0) {
    console.log(
      `\n  WARNING  ${buffered.length}/${ok.length} response(s) carried no identifiable content frame.\n` +
      '           The endpoint buffered the body, or speaks a protocol this script does not\n' +
      '           recognise. For those rows TTFT EQUALS total response time and is NOT a\n' +
      '           time-to-first-token. Do not report NFR-101 from this run until that is resolved.',
    );
  } else {
    const singleChunk = ok.filter((s) => s.chunks <= 1);
    if (singleChunk.length > 0) {
      console.log(
        `\n  NOTE  ${singleChunk.length}/${ok.length} response(s) arrived in a single chunk — ` +
        'TTFT and total are the same event there.',
      );
    }
  }

  if (ok.length < 100) {
    console.log(
      `\n  NOTE  n=${ok.length}. Nearest-rank p99 over ${ok.length} samples is just the maximum ` +
      'observation.\n        Quote p50/p95, or raise --runs, before citing a percentile.',
    );
  }
  if (ok.length === 0) {
    console.error('\nNo successful requests; nothing to summarize.');
    process.exit(1);
  }

  // Reuse the production rollup so a benchmark and a log report are directly
  // comparable rather than two different definitions of p95.
  const logs: ParsedLatencyLogs = {
    ttft:     ok.map((s) => ({ ttftMs: s.ttftMs, role: s.role, meetsNfr101: s.ttftMs < 2000 })),
    complete: ok.map((s) => ({ totalMs: s.totalMs })),
    malformed: 0,
  };

  console.log(`\n${formatLatencySummary(summarizeLatency(logs))}`);

  // Per-query view: an aggregate hides a single pathological query.
  console.log('\n  TTFT by query');
  for (const { q } of QUERIES) {
    const d = describeDistribution(ok.filter((s) => s.query === q).map((s) => s.ttftMs));
    if (d.count > 0) {
      console.log(`    p50=${Math.round(d.p50)}ms  max=${Math.round(d.max)}ms  n=${d.count}  ${q}`);
    }
  }
}

main().catch((err) => {
  console.error('bench:latency failed:', err);
  process.exit(1);
});
