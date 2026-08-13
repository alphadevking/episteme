// src/evals/run-prompt-evals.ts
/**
 * Prompt-behaviour eval runner.
 *
 *   pnpm eval:prompts
 *
 * Runs every case in prompt-eval-dataset.ts against the live agent via
 * Mastra's experiment runner. Each case builds the same server-injected
 * RequestContext the chat-security middleware would produce, so tool
 * authorization behaves exactly as in production. Results and scores are
 * persisted to storage (inspect in Studio) and summarized on stdout.
 *
 * Requires MISTRAL_API_KEY + PINECONE_* in .env.local (hits live services).
 * Exit code 1 if any case fails a scorer below its threshold.
 */

// Load env before importing anything that reads process.env at module scope
// (the Pinecone client in knowledge-retrieval-tool initializes on import).
try { process.loadEnvFile('.env.local'); } catch { /* fall through */ }
try { process.loadEnvFile('.env'); } catch { /* rely on ambient env */ }

// Experiments write traces and scores to storage. .env.local points LIBSQL_URL at
// the production Turso instance, so without this every run would pollute prod
// observability with test data — and fail on its latency (ECONNRESET mid-run).
// db.ts reads LIBSQL_URL at module scope, so this must precede the mastra import;
// that is why the imports below are dynamic. Override with EVAL_LIBSQL_URL.
process.env['LIBSQL_URL'] = process.env['EVAL_LIBSQL_URL'] ?? 'file:./eval-runs.db';
delete process.env['LIBSQL_AUTH_TOKEN']; // a local file DB takes no token

const { RequestContext } = await import('@mastra/core/request-context');
const { runExperiment }  = await import('@mastra/core/datasets');
const { mastra }         = await import('../mastra/index');
const { SESSION_KEYS }   = await import('../mastra/server/session-context');
const { promptEvalCases } = await import('./prompt-eval-dataset');
const { promptEvalScorers } = await import('./prompt-eval-scorers');
const { withRetry, totalBackoffMs } = await import('./retry');

/**
 * Concurrency is env-configurable and defaults to 1.
 *
 * It was hardcoded at 2, which meant the only way to slow a run down was to
 * edit this file — an edit that `git pull` then silently discarded, which is
 * exactly what happened between runs 3 and 4 and cost five cases. Serial is the
 * right default: 13 cases against a 50k tokens/minute ceiling has headroom one
 * at a time, and an eval that finishes slowly beats one that finishes wrong.
 */
const MAX_CONCURRENCY = Math.max(1, Number(process.env['EVAL_MAX_CONCURRENCY'] ?? 1) || 1);

import type { PromptEvalCase } from './prompt-eval-dataset';
import type { EvalRunOutput } from './prompt-eval-scorers';

// Score below this fails the run. Routing/format/leak are binary; faithfulness
// tolerates minor entity-extraction noise.
const PASS_THRESHOLD = 0.8;

// ── Session → RequestContext (mirrors chat-security middleware) ──────────────
function buildRequestContext(c: PromptEvalCase) {
  const rc = new RequestContext();
  rc.set(SESSION_KEYS.role, c.session.role);
  // Mirrors the middleware's fallback: absent role set → [role].
  rc.set(SESSION_KEYS.roles, c.session.roles ?? [c.session.role]);
  rc.set(SESSION_KEYS.trustLevel, c.session.trustLevel);
  rc.set(SESSION_KEYS.isPlatformAdmin, c.session.isPlatformAdmin === true);
  if (c.session.institutionId) rc.set(SESSION_KEYS.institutionId, c.session.institutionId);
  if (c.session.userPublicId)  rc.set(SESSION_KEYS.userPublicId,  c.session.userPublicId);
  if (c.session.namespaceAllowlist) rc.set(SESSION_KEYS.namespaceAllowlist, c.session.namespaceAllowlist);
  return rc;
}

// ── Defensive extractors — tool call/result shapes vary across stream chunks ─
function toolName(entry: unknown): string {
  const e = entry as Record<string, any>;
  return e?.toolName ?? e?.payload?.toolName ?? e?.function?.name ?? '';
}

function toolResultPayload(entry: unknown): Record<string, any> | undefined {
  const e = entry as Record<string, any>;
  const candidate = e?.result ?? e?.payload?.result ?? e?.output ?? e?.payload?.output;
  return typeof candidate === 'object' && candidate !== null ? candidate : undefined;
}

// ── Experiment ────────────────────────────────────────────────────────────────
const agent = mastra.getAgentById('episteme-chat-agent');

const summary = await runExperiment(mastra, {
  name: 'prompt-behaviour-evals',
  description: 'Regression suite for episteme-chat-agent instruction-following.',
  data: promptEvalCases.map((c) => ({
    id: c.id,
    input: c,
    groundTruth: { expect: c.expect, mustNotContain: c.mustNotContain },
    metadata: { notes: c.notes },
  })),
  task: async ({ input }): Promise<EvalRunOutput> => {
    const c = input as PromptEvalCase;
    // A 429 means the case was never asked, not that it answered badly. Waiting
    // out the per-minute window turns a lost measurement back into a real one.
    const result = await withRetry(
      () => agent.generate(c.query, {
        system: c.system,
        requestContext: buildRequestContext(c),
      }),
      {
        onRetry: (attempt, delayMs) =>
          console.log(`  … ${c.id}: rate limited, retry ${attempt} in ${delayMs / 1000}s`),
      },
    );

    const toolsCalled = (result.toolCalls ?? []).map(toolName).filter(Boolean);

    let groundedConfidence: 'high' | 'low' | undefined;
    let toolAnswer: string | undefined;
    // Any source-bearing tier counts — the attribution scorer asks whether the
    // prose's [N](cite:N) badges resolve against whatever source list the client
    // will render, and news and web answers carry one just as the KB does.
    let toolSources: Array<{ number: number }> | undefined;

    for (const tr of result.toolResults ?? []) {
      const payload = toolResultPayload(tr);
      if (!payload) continue;

      if (Array.isArray(payload.sources)) {
        const numbered = payload.sources.filter(
          (s: unknown): s is { number: number } =>
            typeof (s as { number?: unknown })?.number === 'number',
        );
        // A tier that answered from nothing still reports an empty list; that is
        // meaningfully different from no source-bearing tool having run at all.
        toolSources = [...(toolSources ?? []), ...numbered];
      }

      if (toolName(tr) !== 'groundedResponseTool') continue;
      if (payload.confidence === 'high' || payload.confidence === 'low') {
        groundedConfidence = payload.confidence;
        toolAnswer = typeof payload.answer === 'string' ? payload.answer : undefined;
      }
    }

    return { text: result.text, toolsCalled, groundedConfidence, toolAnswer, toolSources };
  },
  scorers: promptEvalScorers,
  maxConcurrency: MAX_CONCURRENCY,
  // Sized FROM the backoff schedule, not guessed. A timeout shorter than the
  // total wait would cancel the very retry the schedule exists to perform,
  // reintroducing the dropped case by another route.
  itemTimeout: totalBackoffMs() + 120_000,
});

// ── Report ────────────────────────────────────────────────────────────────────
let failures = 0;

// Record HOW the run was configured, not just what it produced. Four earlier
// runs had to have their concurrency reconstructed from which cases went
// missing; a results file should never need that kind of forensics.
console.log(
  `\n═══ prompt-behaviour-evals — experiment ${summary.experimentId} ═══\n` +
  `    concurrency ${MAX_CONCURRENCY}` +
  `${MAX_CONCURRENCY > 1 ? ' (set EVAL_MAX_CONCURRENCY=1 if rate limited)' : ''}\n`,
);

for (const item of summary.results) {
  const caseId = (item.input as PromptEvalCase)?.id ?? item.itemId;

  if (item.error) {
    failures++;
    console.log(`✗ ${caseId} — EXECUTION ERROR: ${item.error.message}`);
    continue;
  }

  const failed = item.scores.filter((s) => s.score !== null && s.score < PASS_THRESHOLD);
  const errored = item.scores.filter((s) => s.error);
  const ok = failed.length === 0 && errored.length === 0;
  if (!ok) failures++;

  console.log(`${ok ? '✓' : '✗'} ${caseId}`);
  for (const s of item.scores) {
    const mark = s.error ? '⚠' : (s.score !== null && s.score >= PASS_THRESHOLD ? '·' : '✗');
    const scoreStr = s.score === null ? 'ERR' : s.score.toFixed(2);
    console.log(`    ${mark} ${s.scorerName.padEnd(20)} ${scoreStr}  ${s.error ?? s.reason ?? ''}`);
  }

  // A score alone rarely explains a prompt regression — show the text that
  // produced it so the failure is diagnosable without a second run.
  if (!ok) {
    const text = (item.output as EvalRunOutput | null)?.text ?? '';
    const excerpt = text.length > 600 ? `${text.slice(0, 600)}\n    […truncated]` : text;
    console.log(`    ┌─ response ${'─'.repeat(50)}`);
    console.log(excerpt.split('\n').map((l) => `    │ ${l}`).join('\n'));
    console.log(`    └${'─'.repeat(61)}`);
  }
}

console.log(
  `\n${summary.results.length - failures}/${summary.results.length} cases passed ` +
  `(executed ${summary.succeededCount}, failed ${summary.failedCount}, skipped ${summary.skippedCount}).\n`,
);

process.exitCode = failures > 0 ? 1 : 0;
