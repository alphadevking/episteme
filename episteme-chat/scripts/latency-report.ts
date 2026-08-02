// episteme-chat/scripts/latency-report.ts
/**
 * Roll up the latency telemetry the chat route emits into a distribution.
 *
 *   pnpm latency:report < logs.txt
 *   vercel logs <deployment> | pnpm latency:report
 *   pnpm latency:report logs.txt
 *
 * Answers the question a per-request boolean cannot: what fraction of real
 * traffic meets NFR-101, and what do the tail latencies look like. Reads
 * whatever log text you give it — bare JSON lines or Vercel's prefixed format.
 *
 * Read-only: consumes text, contacts nothing.
 */
import { readFile } from 'node:fs/promises';
import { parseLatencyLogs, summarizeLatency, formatLatencySummary } from '../lib/telemetry/latency';

async function readInput(path: string | undefined): Promise<string> {
  if (path) return readFile(path, 'utf8');

  if (process.stdin.isTTY) {
    console.error(
      'No input. Pipe logs in or pass a file:\n' +
      '  vercel logs <deployment> | pnpm latency:report\n' +
      '  pnpm latency:report logs.txt',
    );
    process.exit(2);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const text = await readInput(process.argv[2]);
  const logs = parseLatencyLogs(text);

  if (logs.ttft.length === 0 && logs.complete.length === 0) {
    console.error(
      'No latency telemetry found in the input.\n' +
      'Expected lines containing {"event":"ttft",...} or {"event":"stream_complete",...}.',
    );
    process.exit(1);
  }

  console.log(formatLatencySummary(summarizeLatency(logs)));
}

main().catch((err) => {
  console.error('latency:report failed:', err);
  process.exit(1);
});
