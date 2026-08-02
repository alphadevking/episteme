// episteme-core/src/evals/run-retrieval-evals.ts
/**
 * Retrieval quality eval — precision@k, recall@k, MRR, nDCG, and abstention.
 *
 *   pnpm eval:retrieval                # score every labelled case
 *   pnpm eval:retrieval --label        # print what retrieval returns for the
 *                                      # unlabelled queries, to write labels from
 *   pnpm eval:retrieval --strict       # exit non-zero if quality or coverage is low
 *
 * Credentials: the PLATFORM tier reads Markdown from disk and always runs. The
 * KB tier needs PINECONE_API_KEY / PINECONE_INDEX / MISTRAL_API_KEY; without
 * them it is skipped with a notice instead of crashing, so the platform numbers
 * are still available. Run it with env loaded by Node, never printed:
 *
 *   node --env-file=.env.local --import tsx src/evals/run-retrieval-evals.ts
 *
 * READ-ONLY. Embeds queries and queries Pinecone; writes nothing, anywhere.
 *
 * WHY A SCRIPT AND NOT A TEST: real retrieval costs embedding calls and depends
 * on live services, so it must never gate `pnpm test`. The scoring rules that
 * must not drift are pure and unit-tested in retrieval-metrics.test.ts.
 */
import { RETRIEVAL_CONFIG } from '../mastra/config';
import { resolvePlatformNamespaces } from '../mastra/security/retrieval-gate';
import { searchPlatformDocs } from '../mastra/tools/platform-docs-tier';
import {
  scoreCase,
  summarize,
  matchesLabel,
  type CaseScore,
  type RetrievedItem,
} from './retrieval-metrics';
import {
  KB_CASES,
  KB_UNLABELLED,
  PLATFORM_CASES,
  kbCoverage,
  type KbCase,
} from './retrieval-golden-set';

const K = RETRIEVAL_CONFIG.maxResults;

// Quality gates for --strict. Deliberately conservative: this is a floor that
// catches regressions, not a target. Raise them as the labelled set grows.
const MIN_PRECISION           = Number(process.env['EVAL_MIN_PRECISION']   ?? 0.7);
const MIN_RECALL              = Number(process.env['EVAL_MIN_RECALL']      ?? 0.7);
const MIN_ABSTENTION_ACCURACY = Number(process.env['EVAL_MIN_ABSTENTION']  ?? 1.0);
const MIN_LABELLED_RETRIEVAL  = Number(process.env['EVAL_MIN_LABELLED']    ?? 5);

const args   = process.argv.slice(2);
const LABEL  = args.includes('--label');
const STRICT = args.includes('--strict');

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const bar = (label: string) => `\n${'='.repeat(78)}\n${label}\n${'='.repeat(78)}`;

function hasKbCredentials(): boolean {
  return Boolean(
    process.env['PINECONE_API_KEY'] && process.env['PINECONE_INDEX'] && process.env['MISTRAL_API_KEY'],
  );
}

/**
 * Imported lazily: knowledge-retrieval-tool builds its Pinecone client at module
 * scope and throws on missing env, so a static import would take down the
 * platform tier too on a machine with no KB credentials.
 */
async function loadRetriever() {
  const mod = await import('../mastra/tools/knowledge-retrieval-tool');
  return mod.retrieveKnowledge;
}

// ── Platform tier ────────────────────────────────────────────────────────────

async function runPlatformCases() {
  console.log(bar('PLATFORM DOCUMENTATION TIER (on-disk corpus, no credentials needed)'));

  const retrievalScores: CaseScore[] = [];
  const abstentionResults: boolean[] = [];
  const failures: string[] = [];

  for (const c of PLATFORM_CASES) {
    const namespaces = resolvePlatformNamespaces({
      trustLevel: c.trustLevel,
      isPlatformAdmin: c.isPlatformAdmin,
    });
    const hit = await searchPlatformDocs(c.query, namespaces);
    const retrieved: RetrievedItem[] = (hit?.sources ?? []).map((s, i) => ({
      source: s.title,
      // The platform tier ranks with BM25 and exposes no numeric score, so
      // position stands in for it. Only ordering is used by the metrics.
      score: 1 / (i + 1),
    }));

    if (c.expect === 'abstain') {
      const correct = retrieved.length === 0;
      abstentionResults.push(correct);
      console.log(`${correct ? 'PASS' : 'FAIL'}  [abstain] ${c.id}`);
      if (!correct) {
        failures.push(`${c.id}: expected no results, got ${retrieved.map((r) => r.source).join(', ')}`);
      }
      continue;
    }

    const score = scoreCase(retrieved, c.expectedTitles, K);
    retrievalScores.push(score);
    const ok = score.anyHit;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  [retrieve] ${c.id}  ` +
      `P=${pct(score.precision)} R=${pct(score.recall)} nDCG=${score.ndcg.toFixed(2)}`,
    );
    if (!ok) {
      failures.push(
        `${c.id}: expected "${c.expectedTitles.join('", "')}", got ` +
        (retrieved.length ? retrieved.map((r) => r.source).join(', ') : '(nothing)'),
      );
    }
  }

  return { summary: summarize(retrievalScores, abstentionResults), failures };
}

// ── Knowledge base tier ──────────────────────────────────────────────────────

async function runKbCases() {
  console.log(bar('KNOWLEDGE BASE TIER (Pinecone)'));

  if (!hasKbCredentials()) {
    console.log(
      'SKIPPED — PINECONE_API_KEY / PINECONE_INDEX / MISTRAL_API_KEY not set.\n' +
      'Run with: node --env-file=.env.local --import tsx src/evals/run-retrieval-evals.ts',
    );
    return null;
  }

  const retrieveKnowledge = await loadRetriever();
  const retrievalScores: CaseScore[] = [];
  const abstentionResults: boolean[] = [];
  const failures: string[] = [];

  for (const c of KB_CASES) {
    const res = await retrieveKnowledge({
      query: c.query,
      role: c.role,
      roles: c.roles,
      trustLevel: c.trustLevel,
      institutionId: c.institutionId,
      programme: c.programme,
      level: c.level,
    });

    const retrieved: RetrievedItem[] = res.found
      ? res.results.map((r) => ({ source: r.source, score: res.maxScore }))
      : [];

    if (c.expect === 'abstain') {
      // Abstention is judged the way the app judges it: found=false, or a best
      // score below the relevance floor. A match that clears scoreThreshold but
      // not relevanceThreshold is not an answer — see RETRIEVAL_CONFIG.
      const abstained = !res.found || res.maxScore < RETRIEVAL_CONFIG.relevanceThreshold;
      abstentionResults.push(abstained);
      console.log(
        `${abstained ? 'PASS' : 'FAIL'}  [abstain] ${c.id}` +
        (res.found ? `  (maxScore=${res.maxScore.toFixed(3)})` : ''),
      );
      if (!abstained) {
        failures.push(
          `${c.id}: expected abstention, got ${retrieved.map((r) => r.source).join(', ')} ` +
          `at maxScore=${res.maxScore.toFixed(3)}`,
        );
      }
      continue;
    }

    const score = scoreCase(retrieved, c.expectedSources, K);
    retrievalScores.push(score);

    // A label that matches nothing in the corpus scores zero and looks like a
    // retrieval failure. Call it out — it is usually a stale or typo'd label.
    const labelMatchedSomething = c.expectedSources.some((label) =>
      retrieved.some((r) => matchesLabel(r.source, label)),
    );
    console.log(
      `${score.anyHit ? 'PASS' : 'FAIL'}  [retrieve] ${c.id}  ` +
      `P=${pct(score.precision)} R=${pct(score.recall)} MRR=${score.reciprocalRank.toFixed(2)} nDCG=${score.ndcg.toFixed(2)}`,
    );
    if (!score.anyHit) {
      failures.push(
        `${c.id}: expected "${c.expectedSources.join('", "')}", got ` +
        (retrieved.length ? retrieved.map((r) => r.source).join(', ') : '(nothing)') +
        (labelMatchedSomething ? '' : '  ← label matched no returned source; check the label itself'),
      );
    }
  }

  return { summary: summarize(retrievalScores, abstentionResults), failures };
}

// ── Labelling aid ────────────────────────────────────────────────────────────

async function runLabelMode() {
  console.log(bar('LABEL MODE — what retrieval returns for the unlabelled queries'));
  console.log(
    'Copy a case into KB_CASES in retrieval-golden-set.ts with the sources that\n' +
    'genuinely answer the query, plus a `why`. Do not paste the current output\n' +
    'wholesale: that would encode today\'s behaviour as the expectation and the\n' +
    'eval could never detect a regression.\n',
  );

  if (!hasKbCredentials()) {
    console.log('SKIPPED — KB credentials not set.');
    return;
  }

  const retrieveKnowledge = await loadRetriever();

  for (const c of KB_UNLABELLED as KbCase[]) {
    const res = await retrieveKnowledge({
      query: c.query,
      role: c.role,
      roles: c.roles,
      trustLevel: c.trustLevel,
      institutionId: c.institutionId,
      programme: c.programme,
      level: c.level,
    });

    console.log(`\n${c.id}  role=${c.role} trust=${c.trustLevel ?? 1}`);
    console.log(`  query: ${c.query}`);
    if (!res.found) {
      console.log('  → nothing retrieved');
      continue;
    }
    console.log(`  → maxScore=${res.maxScore.toFixed(3)}` +
      (res.maxScore < RETRIEVAL_CONFIG.relevanceThreshold ? '  (BELOW relevance floor)' : ''));
    for (const r of res.results.slice(0, K)) {
      console.log(`     ${r.source}${r.updatedAt ? `  (updated ${r.updatedAt.slice(0, 10)})` : '  (undated)'}`);
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

function report(
  title: string,
  result: { summary: ReturnType<typeof summarize>; failures: string[] } | null,
): boolean {
  if (!result) return true;
  const { summary, failures } = result;

  console.log(`\n${title}`);
  if (summary.retrievalCases > 0) {
    console.log(`  cases          ${summary.retrievalCases}`);
    console.log(`  precision@1    ${pct(summary.precisionAt1)}   ← was the top result right`);
    console.log(`  precision@${K}    ${pct(summary.precision)}   ← how much of the context was on-topic`);
    console.log(`  recall@${K}       ${pct(summary.recall)}`);
    console.log(`  MRR            ${summary.mrr.toFixed(3)}`);
    console.log(`  nDCG@${K}         ${summary.ndcg.toFixed(3)}`);
    console.log(`  total misses   ${summary.totalMisses}`);
  } else {
    console.log('  (no labelled retrieval cases)');
  }
  if (summary.abstentionCases > 0) {
    const accuracy = summary.abstentionCorrect / summary.abstentionCases;
    console.log(`  abstention     ${summary.abstentionCorrect}/${summary.abstentionCases} (${pct(accuracy)})`);
  }

  if (failures.length > 0) {
    console.log('\n  failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }

  const abstentionAccuracy = summary.abstentionCases === 0
    ? 1
    : summary.abstentionCorrect / summary.abstentionCases;

  const meetsQuality =
    (summary.retrievalCases === 0 || (summary.precision >= MIN_PRECISION && summary.recall >= MIN_RECALL)) &&
    abstentionAccuracy >= MIN_ABSTENTION_ACCURACY;

  return meetsQuality;
}

async function main() {
  if (LABEL) {
    await runLabelMode();
    return;
  }

  const platform = await runPlatformCases();
  const kb       = await runKbCases();

  console.log(bar('SUMMARY'));
  const platformOk = report('Platform documentation tier', platform);
  const kbOk       = report('Knowledge base tier', kb);

  const coverage = kbCoverage();
  console.log('\nLabelling coverage (knowledge base tier)');
  console.log(`  labelled       ${coverage.labelled} (${coverage.labelledRetrieval} retrieve, ${coverage.labelledAbstention} abstain)`);
  console.log(`  unlabelled     ${coverage.unlabelled}  ← run with --label to work through these`);

  const coverageOk = coverage.labelledRetrieval >= MIN_LABELLED_RETRIEVAL;
  if (!coverageOk) {
    console.log(
      `\nCOVERAGE WARNING: ${coverage.labelledRetrieval} labelled KB retrieve-cases, ` +
      `want at least ${MIN_LABELLED_RETRIEVAL}.\n` +
      'Precision and recall for the knowledge base are NOT yet meaningfully measured. ' +
      'Abstention and the platform tier are.',
    );
  }

  if (STRICT && !(platformOk && kbOk && coverageOk)) {
    console.error('\nFAILED (--strict): quality gates or labelling coverage not met.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('eval:retrieval failed:', err);
  process.exit(1);
});
