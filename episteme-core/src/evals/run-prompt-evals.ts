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

const { RequestContext } = await import('@mastra/core/request-context');
const { runExperiment }  = await import('@mastra/core/datasets');
const { mastra }         = await import('../mastra/index');
const { SESSION_KEYS }   = await import('../mastra/server/session-context');
const { promptEvalCases } = await import('./prompt-eval-dataset');
const { promptEvalScorers } = await import('./prompt-eval-scorers');

import type { PromptEvalCase } from './prompt-eval-dataset';
import type { EvalRunOutput } from './prompt-eval-scorers';

// Score below this fails the run. Routing/format/leak are binary; faithfulness
// tolerates minor entity-extraction noise.
const PASS_THRESHOLD = 0.8;

// ── Session → RequestContext (mirrors chat-security middleware) ──────────────
function buildRequestContext(c: PromptEvalCase) {
  const rc = new RequestContext();
  rc.set(SESSION_KEYS.role, c.session.role);
  rc.set(SESSION_KEYS.trustLevel, c.session.trustLevel);
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
    const result = await agent.generate(c.query, {
      system: c.system,
      requestContext: buildRequestContext(c),
    });

    const toolsCalled = (result.toolCalls ?? []).map(toolName).filter(Boolean);

    let groundedConfidence: 'high' | 'low' | undefined;
    let toolAnswer: string | undefined;
    for (const tr of result.toolResults ?? []) {
      if (toolName(tr) !== 'groundedResponseTool') continue;
      const payload = toolResultPayload(tr);
      if (payload && (payload.confidence === 'high' || payload.confidence === 'low')) {
        groundedConfidence = payload.confidence;
        toolAnswer = typeof payload.answer === 'string' ? payload.answer : undefined;
      }
    }

    return { text: result.text, toolsCalled, groundedConfidence, toolAnswer };
  },
  scorers: promptEvalScorers,
  maxConcurrency: 2,
  itemTimeout: 120_000,
});

// ── Report ────────────────────────────────────────────────────────────────────
let failures = 0;

console.log(`\n═══ prompt-behaviour-evals — experiment ${summary.experimentId} ═══\n`);

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
}

console.log(
  `\n${summary.results.length - failures}/${summary.results.length} cases passed ` +
  `(executed ${summary.succeededCount}, failed ${summary.failedCount}, skipped ${summary.skippedCount}).\n`,
);

process.exitCode = failures > 0 ? 1 : 0;
