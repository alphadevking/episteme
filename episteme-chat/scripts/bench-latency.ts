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

interface Sample { query: string; role: string; ttftMs: number; totalMs: number; ok: boolean }

async function measure(query: string, role: string, trust: number): Promise<Sample> {
  const started = Date.now();
  let ttftMs = -1;

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
    return { query, role, ttftMs: Date.now() - started, totalMs: Date.now() - started, ok: false };
  }

  const reader = res.body.getReader();
  // Read to completion: first chunk gives TTFT, stream close gives total.
  for (;;) {
    const { done } = await reader.read();
    if (ttftMs === -1) ttftMs = Date.now() - started;
    if (done) break;
  }

  return { query, role, ttftMs, totalMs: Date.now() - started, ok: true };
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
    console.log(`  ${String(s.ttftMs).padStart(6)}ms ttft  ${String(s.totalMs).padStart(6)}ms total  [${s.role}] ${s.query}`);
  }
  if (failed > 0) console.log(`\n  ${failed} request(s) failed — excluded from the distribution.`);
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
