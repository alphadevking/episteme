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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RETRIEVAL_CONFIG, RERANK_CONFIG } from '../mastra/config';
import { resolvePlatformNamespaces } from '../mastra/security/retrieval-gate';
import { searchPlatformDocs } from '../mastra/tools/platform-docs-tier';
import { clearsRelevanceGate } from '../mastra/tools/relevance-gate';
import {
  analyzeSeparation,
  classifyAtThreshold,
  scoreCase,
  summarize,
  matchesLabel,
  type CaseScore,
  type RetrievedItem,
} from './retrieval-metrics';
import {
  CASCADE_CASES,
  KB_CASES,
  KB_ENTITLEMENT_CASES,
  KB_UNLABELLED,
  PLATFORM_CASES,
  kbCoverage,
  type KbCase,
} from './retrieval-golden-set';

const K = RETRIEVAL_CONFIG.maxResults;

/** Served from disk, never from the index — excluded from reconciliation. */
const PLATFORM_HELP_NS  = 'platform-help';
const PLATFORM_ADMIN_NS = 'platform-admin';

// Quality gates for --strict. Deliberately conservative: this is a floor that
// catches regressions, not a target. Raise them as the labelled set grows.
const MIN_PRECISION           = Number(process.env['EVAL_MIN_PRECISION']   ?? 0.7);
const MIN_RECALL              = Number(process.env['EVAL_MIN_RECALL']      ?? 0.7);
const MIN_ABSTENTION_ACCURACY = Number(process.env['EVAL_MIN_ABSTENTION']  ?? 1.0);
const MIN_LABELLED_RETRIEVAL  = Number(process.env['EVAL_MIN_LABELLED']    ?? 5);

const args   = process.argv.slice(2);
const LABEL  = args.includes('--label');
const STRICT = args.includes('--strict');
const CORPUS = args.includes('--corpus');
const SCORES = args.includes('--scores');

/**
 * How many times to run each cascade case.
 *
 * The web tier is NOT deterministic — it depends on what a live search returns
 * against the uniben.edu allowlist — so a single observation cannot tell a
 * regression from a flake. On 2026-08-13 the transcript query resolved from the
 * web tier in one run and reached tier=none in the next, same corpus, no code
 * change, and there was no way to say which reading was right.
 *
 *   --repeat 5    run every cascade case five times and report the distribution
 */
const REPEAT = (() => {
  const i = args.indexOf('--repeat');
  if (i === -1) return 1;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
})();

/**
 * The tenant whose documents the eval should be able to see.
 *
 * Retrieval always filters institutionId to `$in: [caller, GLOBAL]`, so a case
 * that supplies no institution sees GLOBAL documents only. If the corpus was
 * ingested under a real institution UUID, every query returns nothing and every
 * abstention case "passes" without testing anything. Run `--corpus` to discover
 * which institution ids are actually present.
 */
const EVAL_INSTITUTION_ID = process.env['EVAL_INSTITUTION_ID'];

/** Every role, for the maximally-privileged control caller. */
const ALL_ROLES = ['prospective', 'student', 'parent', 'staff', 'hod'] as const;
type RetrievalRole = (typeof ALL_ROLES)[number];

/** Narrows an untrusted string to the retrieval role space, or null. */
function asRetrievalRole(raw: string): RetrievalRole | null {
  return (ALL_ROLES as readonly string[]).includes(raw) ? (raw as RetrievalRole) : null;
}

/**
 * Control queries for the corpus probe. Broad, ordinary institutional language:
 * if a full-privilege caller retrieves nothing for ALL of these, the harness
 * cannot see the corpus and no abstention result below means anything.
 */
const CONTROL_QUERIES = [
  'admission requirements for undergraduate students',
  'school fees payment',
  'course registration',
  'university information',
];

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

  // WHICH JUDGE ACTUALLY RULED, observed per case rather than read from config.
  //
  // Reranking is FAIL-SOFT: any error falls back to embedding order and still
  // answers, and it is off by default so it ships dark. Either way the run
  // produces numbers with no indication that the mechanism under test was
  // absent — which is exactly what happened on 2026-08-13, when abstention
  // dropped to 3/4 and the whole cascade collapsed to the KB tier with nothing
  // in the output saying why.
  //
  // config.ts already predicts the signature: "weather in Benin City" hits the
  // handbook at 0.744 on embeddings alone. A result set judged by embedding is
  // therefore not comparable with one judged by cross-encoder, and reporting
  // them under the same heading invites exactly that comparison.
  const judges = new Set<string>();

  for (const c of KB_CASES) {
    const res = await retrieveKnowledge({
      query: c.query,
      role: c.role,
      roles: c.roles,
      trustLevel: c.trustLevel,
      // Falls back to the configured tenant: without it the caller sees only
      // GLOBAL documents, and a case that retrieves nothing verifies nothing.
      institutionId: c.institutionId ?? EVAL_INSTITUTION_ID,
      programme: c.programme,
      level: c.level,
    });

    if (res.found) judges.add(res.judgedBy);

    const retrieved: RetrievedItem[] = res.found
      ? res.results.map((r) => ({ source: r.source, score: res.maxScore }))
      : [];

    if (c.expect === 'abstain') {
      // Abstention is judged EXACTLY as the app judges it — through the same
      // clearsRelevanceGate rule, so the eval cannot drift from production.
      // Comparing maxScore here directly would report the wrong verdict as soon
      // as reranking is on, since the cross-encoder owns the decision then.
      const abstained = !clearsRelevanceGate(res, RETRIEVAL_CONFIG.relevanceThreshold);
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

  return {
    summary: summarize(retrievalScores, abstentionResults),
    failures,
    judges: [...judges].sort(),
  };
}

// ── Threshold calibration (--scores) ─────────────────────────────────────────

/**
 * Out-of-domain probes. Deliberately varied — everyday topics, other countries'
 * institutions, technical questions, and one that names a local place, because
 * a dense retriever will match "Benin City" against a Uniben corpus on the
 * location alone. A calibration set of only silly questions would flatter the
 * system.
 */
const OUT_OF_DOMAIN_PROBES = [
  'how do I bake sourdough bread at home',
  'what is the capital of France',
  'write a python function that sorts a list of numbers',
  'what is the weather forecast for Benin City tomorrow',
  'who won the champions league final',
  'how do I change a flat tyre on my car',
  'what are the symptoms of malaria',
  'best restaurants near me tonight',
  'how do I apply to Harvard University',
  'explain quantum entanglement simply',
];

/**
 * Measure the score distributions that a relevance threshold has to separate.
 *
 * Every probe runs as the SAME full-privilege caller, so the only variable is
 * the query — access scoping is measured elsewhere and would otherwise confound
 * the numbers.
 *
 * In-domain probes are the labelled and unlabelled institutional questions.
 * Their expected DOCUMENT is unknown for most, but that does not matter here:
 * calibration only needs "should retrieve something" vs "should retrieve
 * nothing", and that much is known for every query by construction.
 */
async function runScoreCalibration() {
  console.log(bar('SCORE CALIBRATION (read-only)'));

  if (!hasKbCredentials()) {
    console.log('SKIPPED — KB credentials not set.');
    return;
  }
  if (!EVAL_INSTITUTION_ID) {
    console.log(
      'WARNING: EVAL_INSTITUTION_ID is not set, so only GLOBAL documents are visible.\n' +
      'Scores below will be meaningless if your corpus is institution-scoped. Run --corpus.\n',
    );
  }

  const retrieveKnowledge = await loadRetriever();

  const inDomainQueries = [
    ...KB_CASES.filter((c) => c.expect === 'retrieve').map((c) => c.query),
    ...KB_UNLABELLED.map((c) => c.query),
    ...CONTROL_QUERIES,
  ];

  async function score(query: string): Promise<number> {
    const res = await retrieveKnowledge({
      query,
      role: 'staff',
      roles: [...ALL_ROLES],
      trustLevel: 4,
      institutionId: EVAL_INSTITUTION_ID,
    });
    // Nothing retrieved at all → 0. Such a query cannot be rescued by ANY
    // threshold, and must not be mistaken for "scored low".
    return res.found ? res.maxScore : 0;
  }

  const inDomain: Array<{ query: string; score: number }> = [];
  for (const query of inDomainQueries) inDomain.push({ query, score: await score(query) });

  const outOfDomain: Array<{ query: string; score: number }> = [];
  for (const query of OUT_OF_DOMAIN_PROBES) outOfDomain.push({ query, score: await score(query) });

  const line = (entry: { query: string; score: number }) =>
    `  ${entry.score.toFixed(3)}  ${entry.query.slice(0, 62)}`;

  console.log('\nIN-DOMAIN (should retrieve) — sorted ascending, worst first');
  for (const e of [...inDomain].sort((a, b) => a.score - b.score)) console.log(line(e));

  console.log('\nOUT-OF-DOMAIN (should abstain) — sorted descending, worst first');
  for (const e of [...outOfDomain].sort((a, b) => b.score - a.score)) console.log(line(e));

  // With reranking on, a 0.000 means "the cross-encoder rejected it", not "it
  // scored low". Feeding those zeros into a threshold analysis would report a
  // huge margin and recommend an embedding threshold derived from the rerank
  // layer's decisions — a number that means nothing. Measure the rerank score
  // distribution instead, which is the floor that is actually in play.
  if (RERANK_CONFIG.enabled) {
    await reportRerankCalibration(inDomain, outOfDomain);
    return;
  }

  const analysis = analyzeSeparation(
    inDomain.map((e) => e.score).filter((s) => s > 0), // a zero is a retrieval miss, not a score
    outOfDomain.map((e) => e.score),
  );

  console.log('\n' + '-'.repeat(78));
  console.log(`Current RETRIEVAL_RELEVANCE_THRESHOLD = ${RETRIEVAL_CONFIG.relevanceThreshold}`);
  const current = classifyAtThreshold(
    inDomain.map((e) => e.score).filter((s) => s > 0),
    outOfDomain.map((e) => e.score),
    RETRIEVAL_CONFIG.relevanceThreshold,
  );
  console.log(
    `  at the current value: ${current.falseAnswer} out-of-domain queries would be ANSWERED, ` +
    `${current.falseAbstain} in-domain queries abstained (accuracy ${pct(current.accuracy)})`,
  );

  console.log(`\nlowest in-domain   ${analysis.inDomainMin.toFixed(3)}`);
  console.log(`highest out-of-domain ${analysis.outOfDomainMax.toFixed(3)}`);
  console.log(`margin             ${analysis.margin >= 0 ? '+' : ''}${analysis.margin.toFixed(3)}`);

  if (analysis.cleanlySeparable) {
    console.log(
      `\nSEPARABLE. A threshold of ${analysis.bestThreshold.toFixed(3)} classifies every probe ` +
      'correctly.\nSet RETRIEVAL_RELEVANCE_THRESHOLD to it, then re-run the eval — the ' +
      'abstention\nand retrieve cases together are what keep it honest.',
    );
  } else {
    console.log(
      `\nNOT SEPARABLE. Out-of-domain queries score above in-domain ones, so NO single\n` +
      `threshold classifies everything correctly. The best available is ` +
      `${analysis.bestThreshold.toFixed(3)}, which still\nanswers ${analysis.falseAnswer} ` +
      `out-of-domain and abstains on ${analysis.falseAbstain} in-domain ` +
      `(accuracy ${pct(analysis.accuracy)}).\n\n` +
      'This is evidence that embedding similarity alone cannot express relevance for\n' +
      'this corpus. Tuning the number trades one error for the other; the fix is a\n' +
      'better signal — hybrid retrieval (sparse vectors are already computed at\n' +
      'ingestion; see RETRIEVAL_CONFIG.alpha) or a reranker over the top-k.',
    );
  }

  const misses = inDomain.filter((e) => e.score === 0);
  if (misses.length > 0) {
    console.log(`\n${misses.length} in-domain quer(ies) retrieved NOTHING — no threshold can fix these:`);
    for (const m of misses) console.log(`  - ${m.query}`);
  }
}

/**
 * Measure the RAW cross-encoder scores, so RERANK_MIN_SCORE is chosen from data
 * rather than from which queries happened to survive the current floor.
 *
 * The production path applies the floor and discards what it rejects, so a
 * query that returns nothing is indistinguishable from one that scored just
 * below the cutoff. This reruns the same candidates with NO floor and reports
 * the best score each query achieved, turning "it abstained" into "it scored
 * 0.28, and your floor is 0.30".
 *
 * Retrieval is reproduced directly here (embed → query → rerank) rather than
 * called through retrieveKnowledge, because that function deliberately does not
 * expose rerank scores. This is a measurement of the reranker, not a test of
 * the production path — the eval's abstention cases remain the test.
 */
async function reportRerankCalibration(
  inDomain: Array<{ query: string; score: number }>,
  outOfDomain: Array<{ query: string; score: number }>,
) {
  const { Pinecone } = await import('@pinecone-database/pinecone');
  const { embedTexts } = await import('../mastra/ingestion/embedder');
  const { resolveNamespacesForRoles, buildRetrievalFilter } =
    await import('../mastra/security/retrieval-gate');

  const pc = new Pinecone({ apiKey: process.env['PINECONE_API_KEY']! });
  const index = pc.index({ name: process.env['PINECONE_INDEX']! });
  const namespaces = resolveNamespacesForRoles({ roles: [...ALL_ROLES], trustLevel: 4 });
  const filter = buildRetrievalFilter({ role: [...ALL_ROLES], institutionId: EVAL_INSTITUTION_ID });

  /** Best cross-encoder score for a query, with no floor applied. */
  async function topRerankScore(query: string): Promise<number> {
    const [vec] = await embedTexts([query]);
    const candidates: string[] = [];
    for (const ns of namespaces) {
      const res = await index.namespace(ns).query({
        vector: vec!, topK: RETRIEVAL_CONFIG.topK, includeMetadata: true, filter,
      });
      for (const m of res.matches ?? []) {
        const text = String((m.metadata ?? {})['text'] ?? '');
        if (text) candidates.push(text);
      }
    }
    if (candidates.length === 0) return 0;

    const documents = candidates.slice(0, RERANK_CONFIG.topN);
    const response = await pc.inference.rerank({
      model: RERANK_CONFIG.model,
      query,
      documents,
      topN: documents.length,
      returnDocuments: false,
    });
    const scores = (response.data ?? []).map((r) => Number(r.score ?? 0));
    return scores.length ? Math.max(...scores) : 0;
  }

  console.log('\n' + '-'.repeat(78));
  console.log(`RERANK CALIBRATION — model ${RERANK_CONFIG.model}, current floor ${RERANK_CONFIG.minScore}`);
  console.log('Raw cross-encoder scores, NO floor applied.\n');

  const inScores: number[] = [];
  console.log('IN-DOMAIN (should retrieve)');
  for (const e of inDomain) {
    const score = await topRerankScore(e.query);
    inScores.push(score);
    const verdict = score < RERANK_CONFIG.minScore ? '  ← REJECTED by current floor' : '';
    console.log(`  ${score.toFixed(4)}  ${e.query.slice(0, 58)}${verdict}`);
  }

  const outScores: number[] = [];
  console.log('\nOUT-OF-DOMAIN (should abstain)');
  for (const e of outOfDomain) {
    const score = await topRerankScore(e.query);
    outScores.push(score);
    const verdict = score >= RERANK_CONFIG.minScore ? '  ← ANSWERED despite current floor' : '';
    console.log(`  ${score.toFixed(4)}  ${e.query.slice(0, 58)}${verdict}`);
  }

  const analysis = analyzeSeparation(inScores, outScores);
  console.log('\n' + '-'.repeat(78));
  console.log(`lowest in-domain      ${analysis.inDomainMin.toFixed(4)}`);
  console.log(`highest out-of-domain ${analysis.outOfDomainMax.toFixed(4)}`);
  console.log(`margin                ${analysis.margin >= 0 ? '+' : ''}${analysis.margin.toFixed(4)}`);

  const current = classifyAtThreshold(inScores, outScores, RERANK_CONFIG.minScore);
  console.log(
    `\nat the current floor (${RERANK_CONFIG.minScore}): ` +
    `${current.falseAnswer} out-of-domain answered, ${current.falseAbstain} in-domain abstained ` +
    `(accuracy ${pct(current.accuracy)})`,
  );

  if (analysis.cleanlySeparable) {
    console.log(
      `\nSEPARABLE on rerank score. Any floor in (${analysis.outOfDomainMax.toFixed(4)}, ` +
      `${analysis.inDomainMin.toFixed(4)}] classifies every probe correctly.\n` +
      `Suggested RERANK_MIN_SCORE=${analysis.bestThreshold.toFixed(4)} — pick nearer the LOW end ` +
      'of that range\nto leave headroom for genuine queries not in this sample.',
    );
  } else {
    console.log(
      `\nNOT SEPARABLE on rerank score either. Best floor ${analysis.bestThreshold.toFixed(4)} ` +
      `still answers ${analysis.falseAnswer}\nout-of-domain and abstains on ${analysis.falseAbstain} ` +
      'in-domain (accuracy ' + pct(analysis.accuracy) + ').\n\n' +
      'Before blaming the reranker, check whether the "in-domain" queries it rejects are\n' +
      'answerable from THIS corpus at all — a question about fees is correctly abstained\n' +
      'on when no fee document has been ingested. Confirm with --label, and move any\n' +
      'genuinely-unanswerable query out of the in-domain set.',
    );
  }

  const lowInDomain = inDomain
    .map((e, i) => ({ query: e.query, score: inScores[i]! }))
    .filter((e) => e.score < RERANK_CONFIG.minScore);
  if (lowInDomain.length > 0) {
    console.log(
      `\n${lowInDomain.length} in-domain quer(ies) fall below the current floor. For each, decide:\n` +
      'is the answer actually IN the corpus (→ lower the floor) or not (→ correct abstention,\n' +
      'and the query does not belong in the in-domain set)?',
    );
    for (const e of lowInDomain) console.log(`  ${e.score.toFixed(4)}  ${e.query}`);
  }
}

// ── Cascade tier (KB → news → web) ───────────────────────────────────────────

/**
 * Exercises the WHOLE grounded cascade, not just retrieval.
 *
 * Everything above measures tier 1 in isolation. But the user-visible behaviour
 * of a KB miss is decided by what happens next: an institutional question the
 * corpus cannot answer should fall through to news or web and come back with a
 * caveated answer, NOT abstain. Nothing tested that path, and tightening the
 * relevance gate makes it fire far more often — precisely the moment it stops
 * being safe to assume it works.
 *
 * Reports the tier that answered rather than pass/fail, because the honest
 * expectation is environment-dependent: the web tier is allowlisted to
 * uniben.edu and the national regulators, so whether a given query resolves
 * depends on what those sites actually publish today. A hard assertion here
 * would fail for reasons that are not defects.
 */
async function runCascadeCases() {
  console.log(bar('CASCADE (KB → news → web) — which tier answers'));

  if (!hasKbCredentials()) {
    console.log('SKIPPED — KB credentials not set.');
    return;
  }

  const { RequestContext } = await import('@mastra/core/request-context');
  const { SESSION_KEYS } = await import('../mastra/server/session-context');
  const { groundedResponseTool } = await import('../mastra/tools/grounded-response-tool');

  if (REPEAT > 1) {
    console.log(`  Running each case ${REPEAT} times to separate flake from regression.\n`);
  }

  for (const c of CASCADE_CASES) {
    const rc = new RequestContext();
    rc.set(SESSION_KEYS.role, c.role);
    rc.set(SESSION_KEYS.roles, [c.role]);
    rc.set(SESSION_KEYS.trustLevel, c.trustLevel);
    rc.set(SESSION_KEYS.isPlatformAdmin, c.isPlatformAdmin === true);
    if (EVAL_INSTITUTION_ID) rc.set(SESSION_KEYS.institutionId, EVAL_INSTITUTION_ID);

    // Tier per attempt. With --repeat this is the whole point: a query that
    // answers 4 times out of 5 is a non-deterministic fallback, not a defect,
    // and only the distribution can say so.
    const tiers: string[] = [];
    let confidence = 'unknown';

    for (let attempt = 0; attempt < REPEAT; attempt++) {
      try {
        const result = await (groundedResponseTool.execute as unknown as (
          input: unknown, ctx: unknown,
        ) => Promise<{ tier?: string; confidence?: string }>)(
          { query: c.query },
          { requestContext: rc },
        );
        tiers.push(result?.tier ?? 'unknown');
        confidence = result?.confidence ?? 'unknown';
      } catch (err) {
        tiers.push('ERROR');
        if (REPEAT === 1) console.log(`  ERROR     ${c.query}: ${(err as Error).message}`);
      }
    }

    // Tally, most frequent first.
    const tally = new Map<string, number>();
    for (const t of tiers) tally.set(t, (tally.get(t) ?? 0) + 1);
    const ranked = [...tally].sort((a, b) => b[1] - a[1]);
    const dominant = ranked[0]?.[0] ?? 'unknown';

    // Flag both failure shapes: nothing answered when something should have,
    // and the WRONG tier answering — which is how the platform/KB hijack
    // showed up in the first place. Judged on the DOMINANT tier, so one flaky
    // attempt does not condemn a case that mostly works.
    const flag =
      c.expectAnswered && dominant === 'none' ? '  ← expected a fallback tier to answer this'
      : c.expectTier && dominant !== c.expectTier ? `  ← expected tier=${c.expectTier}`
      : '';

    if (REPEAT === 1) {
      console.log(`  tier=${dominant.padEnd(9)} confidence=${String(confidence).padEnd(5)} ${c.query}${flag}`);
    } else {
      const spread = ranked.map(([t, n]) => `${t}x${n}`).join(' ');
      // An unstable case is the finding. Say so on the line itself rather than
      // leaving a reader to compare counts across runs by eye.
      const stability = ranked.length > 1 ? '  ← UNSTABLE' : '';
      console.log(`  ${spread.padEnd(22)} ${c.query}${flag}${stability}`);
    }
  }

  console.log(
    '\n  Read this as coverage, not a score: `kb` means the corpus answered, `news`/`web`\n' +
    '  mean the fallback did its job, and `none` on an institutional question is the\n' +
    '  signal worth investigating — either the allowlist is too narrow or the question\n' +
    '  genuinely has no published source.',
  );
}

// ── Corpus reachability control ──────────────────────────────────────────────

/**
 * Proves the harness can retrieve ANYTHING before any abstention result is
 * allowed to count as a pass.
 *
 * Without this, an eval that cannot see the corpus reports a perfect abstention
 * score — the most misleading output it could produce, because "returned
 * nothing" is both the success signal for abstention and the symptom of a
 * misconfigured harness. A green tick that cannot fail is worse than a red one.
 */
async function probeCorpus(): Promise<{ reachable: boolean; hits: number; sources: string[] }> {
  const retrieveKnowledge = await loadRetriever();
  const sources = new Set<string>();
  let hits = 0;

  for (const query of CONTROL_QUERIES) {
    const res = await retrieveKnowledge({
      query,
      role: 'staff',
      roles: [...ALL_ROLES],
      trustLevel: 4,
      institutionId: EVAL_INSTITUTION_ID,
    });
    if (res.found) {
      hits += res.results.length;
      for (const r of res.results) sources.add(r.source);
    }
  }

  return { reachable: hits > 0, hits, sources: [...sources] };
}

/**
 * Read-only inspection of what is actually in the index, so the institution id
 * and namespaces can be discovered rather than guessed. `--corpus`.
 */
async function inspectCorpus() {
  console.log(bar('CORPUS INSPECTION (read-only)'));

  if (!hasKbCredentials()) {
    console.log('SKIPPED — KB credentials not set.');
    return;
  }

  const { Pinecone } = await import('@pinecone-database/pinecone');
  const { embedTexts } = await import('../mastra/ingestion/embedder');

  const index = new Pinecone({ apiKey: process.env['PINECONE_API_KEY']! })
    .index({ name: process.env['PINECONE_INDEX']! });

  const stats = await index.describeIndexStats();
  console.log(`\nIndex "${process.env['PINECONE_INDEX']}" — ${stats.totalRecordCount ?? 0} vectors\n`);

  const namespaces = Object.entries(stats.namespaces ?? {});
  if (namespaces.length === 0) {
    console.log('No namespaces contain vectors — the index is empty.');
    return;
  }

  // One embedding, reused across namespaces: this is a sampler, not a search.
  const [vec] = await embedTexts(['university student information']);

  for (const [ns, nsStats] of namespaces) {
    const institutions = new Set<string>();
    const roles = new Set<string>();
    const sources = new Set<string>();

    // No filter — deliberately bypasses the gate to reveal what EXISTS, which
    // is the whole point of an inspection. Nothing here asserts access.
    const res = await index.namespace(ns).query({
      vector: vec!, topK: 10, includeMetadata: true,
    });
    for (const match of res.matches ?? []) {
      const m = (match.metadata ?? {}) as Record<string, unknown>;
      if (typeof m['institutionId'] === 'string') institutions.add(m['institutionId']);
      if (Array.isArray(m['roles'])) for (const r of m['roles'] as string[]) roles.add(r);
      if (typeof m['source'] === 'string') sources.add(m['source'].slice(0, 60));
    }

    console.log(`${ns}  (${nsStats.recordCount ?? 0} vectors)`);
    console.log(`  institutionId: ${institutions.size ? [...institutions].join(', ') : '(none sampled)'}`);
    console.log(`  roles:         ${roles.size ? [...roles].join(', ') : '(none sampled)'}`);
    for (const s of [...sources].slice(0, 3)) console.log(`  source:        ${s}`);
  }

  console.log(
    '\nIf the institutionId above is NOT "__global__", set it so the eval can see ' +
    'these documents:\n  EVAL_INSTITUTION_ID=<uuid>',
  );
}

// ── Entitlement (access control through the real retrieval path) ─────────────

/**
 * Verifies every chunk a restricted caller received against what that caller is
 * entitled to see. See the commentary on EntitlementCase for why this asserts
 * per-chunk properties instead of comparing two callers' result sets.
 *
 * Read-only: retrieval queries plus Pinecone `fetch` by id.
 */
async function runEntitlementCases() {
  console.log(bar('ENTITLEMENT (access control, end to end through retrieval)'));

  if (!hasKbCredentials()) {
    console.log('SKIPPED — KB credentials not set.');
    return null;
  }

  const { Pinecone } = await import('@pinecone-database/pinecone');
  const {
    resolveNamespacesForRoles, expandAudienceRoles, GLOBAL_INSTITUTION,
    ROLE_NAMESPACES, TRUST_NAMESPACES,
  } = await import('../mastra/security/retrieval-gate');
  const { assessExclusionCoverage, formatExclusionCoverage, knownNamespaces } =
    await import('./entitlement-coverage');
  const retrieveKnowledge = await loadRetriever();

  const index = new Pinecone({ apiKey: process.env['PINECONE_API_KEY']! })
    .index({ name: process.env['PINECONE_INDEX']! });

  // A vector census, so the harness can tell an exclusion that WITHHELD content
  // from one that merely described an empty namespace. Pinecone omits empty
  // namespaces entirely, so an absent key means zero.
  const indexStats = await index.describeIndexStats();
  const census: Record<string, number> = Object.fromEntries(
    Object.entries(indexStats.namespaces ?? {})
      .map(([ns, st]) => [ns, (st as { recordCount?: number }).recordCount ?? 0]),
  );
  const universe = knownNamespaces(ROLE_NAMESPACES, TRUST_NAMESPACES);

  const failures: string[] = [];
  const vacuousCases: string[] = [];
  let chunksInspected = 0;
  let casesWithResults = 0;

  for (const c of KB_ENTITLEMENT_CASES) {
    const allowedNamespaces = resolveNamespacesForRoles({
      roles: c.roles,
      trustLevel: c.trustLevel,
      namespaceAllowlist: c.namespaceAllowlist,
    });

    const res = await retrieveKnowledge({
      query: c.query,
      role: c.roles[0]!,
      roles: c.roles,
      trustLevel: c.trustLevel,
      // Falls back to the configured tenant: without it the caller sees only
      // GLOBAL documents, and a case that retrieves nothing verifies nothing.
      institutionId: c.institutionId ?? EVAL_INSTITUTION_ID,
      namespaceAllowlist: c.namespaceAllowlist,
    });

    if (!res.found || res.results.length === 0) {
      console.log(`  --   ${c.id}: no results (nothing to verify)`);
      continue;
    }
    casesWithResults++;

    const violations: string[] = [];

    for (const result of res.results) {
      chunksInspected++;

      // Locate the chunk within the namespaces this caller may search. A chunk
      // that came from a forbidden namespace is simply not there — absence is
      // the leak detector.
      let found: Record<string, unknown> | null = null;
      for (const ns of allowedNamespaces) {
        const fetched = await index.namespace(ns).fetch({ ids: [result.chunkId] });
        const record = fetched.records?.[result.chunkId];
        if (record?.metadata) { found = record.metadata as Record<string, unknown>; break; }
      }

      if (!found) {
        violations.push(
          `chunk ${result.chunkId} (${result.source}) is not present in any namespace ` +
          `this caller may search [${allowedNamespaces.join(', ')}]`,
        );
        continue;
      }

      // Audience progression means a senior caller legitimately receives
      // documents tagged for junior audiences, so the readable set is the
      // expansion — not the caller's literal roles.
      //
      // This dimension necessarily mirrors the implementation, which weakens it
      // as an independent check; expandAudienceRoles is separately guarded by
      // the rank-based property test in retrieval-gate.test.ts. The namespace
      // and institution checks below remain fully independent of it, and the
      // upward direction — a junior caller receiving senior-tagged content —
      // is still caught here, which is the direction that matters.
      const readableAudiences = expandAudienceRoles([...c.roles]);
      const chunkRoles = Array.isArray(found['roles']) ? (found['roles'] as string[]) : [];
      if (chunkRoles.length > 0 && !chunkRoles.some((r) => readableAudiences.includes(r))) {
        violations.push(
          `chunk ${result.chunkId} (${result.source}) is tagged roles=[${chunkRoles.join(', ')}] ` +
          `but the caller may read [${readableAudiences.join(', ')}]`,
        );
      }

      const chunkInstitution = found['institutionId'];
      const permittedInstitutions = [
        c.institutionId ?? EVAL_INSTITUTION_ID ?? GLOBAL_INSTITUTION,
        GLOBAL_INSTITUTION,
      ];
      if (typeof chunkInstitution === 'string' && !permittedInstitutions.includes(chunkInstitution)) {
        violations.push(
          `chunk ${result.chunkId} (${result.source}) belongs to institution ` +
          `${chunkInstitution}, caller is scoped to [${permittedInstitutions.join(', ')}]`,
        );
      }
    }

    // Could this case's exclusions have failed at all? A green access-control
    // result nobody can falsify is worse than a red one — it gets written up as
    // evidence. Reported per case rather than aggregated so the specific
    // assertion that is hollow is named.
    const coverage = assessExclusionCoverage(allowedNamespaces, universe, census);
    if (coverage.whollyVacuous) vacuousCases.push(c.id);

    console.log(
      `${violations.length === 0 ? 'PASS' : 'FAIL'}  ${c.id}  ` +
      `(${res.results.length} chunk(s), namespaces: ${allowedNamespaces.join(', ')})`,
    );
    console.log(`        exclusions: ${formatExclusionCoverage(coverage)}`);
    for (const v of violations) failures.push(`${c.id}: ${v}`);
  }

  if (vacuousCases.length > 0) {
    console.log(
      `\n  WARNING  ${vacuousCases.length} case(s) rest ENTIRELY on empty namespaces: ` +
      `${vacuousCases.join(', ')}.\n` +
      '           Every exclusion they assert is unfalsifiable against this corpus — nothing\n' +
      '           is there to leak. They cannot be cited as access-control evidence until a\n' +
      '           document is ingested into the namespaces they guard.',
    );
  }

  return {
    failures, chunksInspected, casesWithResults,
    totalCases: KB_ENTITLEMENT_CASES.length, vacuousCases,
  };
}

// ── Registry reconciliation (does the registry match the index?) ─────────────

/**
 * The registry and the index are written by the same ingestion run and nothing
 * keeps them in step afterwards — by design, since db.ts deliberately keeps the
 * registry off the chat path. This is the only check that notices when they part.
 */
async function runRegistryReconciliation(): Promise<{ reconciled: boolean } | null> {
  console.log(bar('REGISTRY RECONCILIATION (kb_documents vs resident vectors)'));

  if (!hasKbCredentials()) {
    console.log('SKIPPED — KB credentials not set.');
    return null;
  }

  const { Pinecone } = await import('@pinecone-database/pinecone');
  const { reconcileRegistry, formatReconciliation } = await import('./registry-reconciliation');

  let documents;
  try {
    const { listDocuments } = await import('../mastra/ingestion/kb-store');
    documents = await listDocuments();
  } catch (err) {
    // The registry is deliberately not on the chat path, so it can be
    // unreachable while everything else here works. Say which half failed
    // rather than reporting a reconciliation result that examined one side.
    console.log(`SKIPPED — the registry is unreachable: ${(err as Error).message}`);
    console.log('Reconciliation needs LIBSQL_URL; the index side alone proves nothing.');
    return null;
  }

  const index = new Pinecone({ apiKey: process.env['PINECONE_API_KEY']! })
    .index({ name: process.env['PINECONE_INDEX']! });
  const stats = await index.describeIndexStats();
  const census: Record<string, number> = Object.fromEntries(
    Object.entries(stats.namespaces ?? {})
      .map(([ns, st]) => [ns, (st as { recordCount?: number }).recordCount ?? 0]),
  );

  // The platform tier ships in the repository and is read from disk, so it has
  // no registry rows by design and must not be reported as unregistered.
  const report = reconcileRegistry(
    documents.map((d) => ({
      docId: d.docId, fileName: d.fileName,
      namespace: d.namespace, vectorsUpserted: d.vectorsUpserted,
    })),
    census,
    [PLATFORM_HELP_NS, PLATFORM_ADMIN_NS],
  );

  console.log(formatReconciliation(report));
  return { reconciled: report.reconciled };
}

// ── Suggestion chips (the product's promises) ────────────────────────────────

/**
 * A shipped suggestion chip, as recorded in episteme-chat's catalogue.
 * Mirrors CatalogueEntry there; only the fields this eval asserts against.
 */
type SuggestionEntry = {
  id: string;
  prompt: string;
  roles: string[];
  minTrust: number;
  tier: 'kb' | 'platform';
  namespace: string;
  expectedSource: string;
  requiresPlatformAdmin?: boolean;
};

/**
 * WHY THE CHIPS ARE EVALUATED HERE.
 *
 * A suggestion chip is a promise: it tells a user "ask me this and I will
 * answer". Before this ran, the chips were a hardcoded list that had drifted
 * completely away from the corpus — offering scholarships, fee payment, exam
 * results, accreditation and departmental budgets, none of which any ingested
 * document covers. Every one of those spent a user's FIRST click on a refusal.
 *
 * Hand-auditing the list fixes the day it is audited and rots by the next
 * ingest. So the list is data, and this asserts the data is still true against
 * the live corpus: same retrieval path, same gate, same relevance rule the app
 * uses. A chip that stops being answerable now fails the run.
 *
 * EACH ROLE IS TESTED SEPARATELY, not as a union. The union hides exactly the
 * bug that motivated this: an HOD holds the `admissions` namespace but matches
 * no record in it, so a chip shown to [prospective, student, hod] would pass on
 * the union while failing for the one role that could not answer it.
 *
 * The catalogue lives in episteme-chat because that is where chips are
 * rendered; the packages share no workspace, so it is read from disk. That
 * coupling is dev-time only — this eval is a developer tool, never a runtime
 * dependency of either service.
 */
function loadSuggestionCatalogue(): { entries: SuggestionEntry[]; path: string } | null {
  const override = process.env['EVAL_SUGGESTION_CATALOGUE'];
  const url = override
    ? new URL(`file://${override.replace(/\\/g, '/')}`)
    : new URL('../../../episteme-chat/lib/suggestions.catalogue.json', import.meta.url);

  try {
    const raw = readFileSync(url, 'utf8');
    const parsed = JSON.parse(raw) as { suggestions?: SuggestionEntry[] };
    if (!Array.isArray(parsed.suggestions)) return null;
    return { entries: parsed.suggestions, path: fileURLToPath(url) };
  } catch {
    return null;
  }
}

async function runSuggestionCases() {
  console.log(bar('SUGGESTION CHIPS (every shipped chip must still be answerable)'));

  const catalogue = loadSuggestionCatalogue();
  if (!catalogue) {
    console.log(
      'SKIPPED — suggestions.catalogue.json not found.\n' +
      'Expected alongside episteme-chat/lib/. Set EVAL_SUGGESTION_CATALOGUE=<abs path>\n' +
      'if the chat package lives elsewhere on this machine.',
    );
    return null;
  }

  console.log(`catalogue: ${catalogue.path}  (${catalogue.entries.length} shipped chip(s))\n`);

  const failures: string[] = [];
  let checks = 0;

  const kbEntries = catalogue.entries.filter((e) => e.tier === 'kb');
  const kbUsable  = hasKbCredentials();
  if (kbEntries.length > 0 && !kbUsable) {
    console.log('  (KB-backed chips skipped — no KB credentials)');
  }
  // THROUGH THE WHOLE CASCADE, not just retrieval.
  //
  // This used to call retrieveKnowledge directly, and that made it report green
  // on a chip users saw fail. Retrieval was genuinely fine — "what are the
  // examination rules" matched the handbook at 0.794 — but the handbook is
  // dated 2022, the cascade treated any stale match as beatable, and web search
  // answered instead. The guard asserted the component while the product did
  // something else.
  //
  // A chip is a promise about the ANSWER, so it has to be judged on the answer.
  // tier must come back `kb`: not "something replied", but "the corpus replied",
  // which is the only outcome that makes a knowledge-base chip honest.
  const cascade = kbEntries.length > 0 && kbUsable
    ? {
        tool: (await import('../mastra/tools/grounded-response-tool')).groundedResponseTool,
        RequestContext: (await import('@mastra/core/request-context')).RequestContext,
        SESSION_KEYS: (await import('../mastra/server/session-context')).SESSION_KEYS,
      }
    : null;

  for (const entry of catalogue.entries) {
    for (const role of entry.roles) {
      // The exact envelope this chip is shown under: one role, and the lowest
      // trust at which the UI will display it. Testing it any wider would prove
      // something the UI never relies on.
      const label = `${entry.id} [role=${role} trust=${entry.minTrust}]`;

      if (entry.tier === 'platform') {
        const namespaces = resolvePlatformNamespaces({
          trustLevel: entry.minTrust,
          isPlatformAdmin: entry.requiresPlatformAdmin === true,
        });
        const hit = await searchPlatformDocs(entry.prompt, namespaces);
        const titles = (hit?.sources ?? []).map((s) => s.title);
        const ok = titles.some((t) => matchesLabel(t, entry.expectedSource));
        checks++;
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
        if (!ok) {
          failures.push(
            `${label}: expected "${entry.expectedSource}", got ` +
            (titles.length ? titles.join(', ') : '(nothing)'),
          );
        }
        continue;
      }

      if (!cascade) continue;

      // The catalogue is JSON, so its roles are untyped strings. A role that is
      // not in the retrieval role space cannot be gated correctly — silently
      // casting it would test a chip under an envelope the app would never
      // produce, so it fails here instead.
      const retrievalRole = asRetrievalRole(role);
      if (!retrievalRole) {
        checks++;
        console.log(`FAIL  ${label}`);
        failures.push(
          `${label}: "${role}" is not a retrieval role (${ALL_ROLES.join(', ')}) — ` +
          'the chip would be filtered by a role the gate does not understand',
        );
        continue;
      }

      const rc = new cascade.RequestContext();
      rc.set(cascade.SESSION_KEYS.role, retrievalRole);
      rc.set(cascade.SESSION_KEYS.roles, [retrievalRole]);
      rc.set(cascade.SESSION_KEYS.trustLevel, entry.minTrust);
      rc.set(cascade.SESSION_KEYS.isPlatformAdmin, entry.requiresPlatformAdmin === true);
      if (EVAL_INSTITUTION_ID) rc.set(cascade.SESSION_KEYS.institutionId, EVAL_INSTITUTION_ID);

      let tier = 'error';
      let titles: string[] = [];
      // Match on the URL as well as the display title. `expectedSource` names a
      // DOCUMENT, and the url is its stable identifier; the title is derived for
      // presentation (deriveTitle renders "admission_policy.html" as "Admission
      // Policy"), so asserting on the title alone fails whenever a filename
      // contains a separator — a formatting difference reported as a broken
      // chip. STUDENTHANDBOOK only passed because it has nothing to reformat.
      let identifiers: string[] = [];
      try {
        const result = await (cascade.tool.execute as unknown as (
          input: unknown, ctx: unknown,
        ) => Promise<{ tier?: string; sources?: Array<{ title?: string; url?: string }> }>)(
          { query: entry.prompt },
          { requestContext: rc },
        );
        tier = result?.tier ?? 'none';
        titles = (result?.sources ?? []).map((src) => src.title ?? '');
        identifiers = (result?.sources ?? []).flatMap((src) =>
          [src.title, src.url].filter((v): v is string => Boolean(v)),
        );
      } catch (err) {
        failures.push(`${label}: cascade threw — ${(err as Error).message}`);
      }

      const answeredByKb = tier === 'kb';
      const ok = answeredByKb && identifiers.some((id) => matchesLabel(id, entry.expectedSource));

      checks++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  tier=${tier}`);
      if (!ok && tier !== 'error') {
        failures.push(
          `${label}: expected tier=kb citing "${entry.expectedSource}", got tier=${tier}` +
          (titles.length ? ` citing ${titles.join(', ')}` : ' with no sources') +
          (answeredByKb
            // Right tier, wrong document. The user is NOT seeing an abstention
            // here, so it must not be described as one — this is either a stale
            // expectedSource or the corpus genuinely answering from elsewhere.
            ? '  ← the corpus answered, but cited a different document; check expectedSource'
            : tier === 'none'
              ? '  ← the user sees "no verified information" for a chip we offer them'
              : `  ← a ${tier} source answered instead of the corpus`),
        );
      }
    }
  }

  return { failures, checks };
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
      // Falls back to the configured tenant: without it the caller sees only
      // GLOBAL documents, and a case that retrieves nothing verifies nothing.
      institutionId: c.institutionId ?? EVAL_INSTITUTION_ID,
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

/**
 * The commit the run executed at, or 'unknown' outside a git checkout.
 *
 * Not decoration. Twice in this project a result was misattributed because
 * nobody recorded which build produced it: a latency figure was credited to a
 * benchmark fix that was not yet in the tree, and a retrieval run was compared
 * against one taken at a different commit. A saved eval output that cannot name
 * its own build cannot be reasoned about later.
 */
function currentCommit(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return 'unknown';
  }
}

/**
 * Declare the configuration under test before any number is printed.
 *
 * Every run of this script is a candidate artefact for the evaluation chapter,
 * and two runs differing only in RERANK_ENABLED produce entirely incomparable
 * knowledge-base figures. A saved transcript must therefore be self-describing:
 * a reader holding two files should be able to tell which is which without
 * consulting a shell history that no longer exists.
 */
function reportConfiguration() {
  console.log(bar('CONFIGURATION UNDER TEST'));
  console.log(`commit                ${currentCommit()}`);
  console.log(`run at                ${new Date().toISOString()}`);
  console.log(`tenant                ${EVAL_INSTITUTION_ID ?? '(unset — GLOBAL documents only)'}`);
  console.log(`credentials           KB ${hasKbCredentials() ? 'present' : 'ABSENT — knowledge-base tier will skip'}`);
  console.log(`retrieval             k=${K}  embedding floor=${RETRIEVAL_CONFIG.relevanceThreshold}`);
  console.log(
    `rerank                ${RERANK_CONFIG.enabled ? 'ENABLED' : 'DISABLED'}` +
    (RERANK_CONFIG.enabled
      ? `  model=${RERANK_CONFIG.model}  floor=${RERANK_CONFIG.minScore}  topN=${RERANK_CONFIG.topN}`
      : '  ← the cross-encoder will not rule; see the summary'),
  );
  console.log(`cascade repeats       ${REPEAT}${REPEAT === 1 ? '  (web tier is non-deterministic — consider --repeat 5)' : ''}`);
}

async function main() {
  // Before anything measurable. The calibration and label modes get it too:
  // a threshold recommendation is only interpretable against the corpus and
  // judge configuration that produced it.
  reportConfiguration();

  if (CORPUS) {
    await inspectCorpus();
    return;
  }
  if (SCORES) {
    await runScoreCalibration();
    return;
  }
  if (LABEL) {
    await runLabelMode();
    return;
  }

  const platform = await runPlatformCases();

  // Reachability first: every KB result below is interpreted in its light.
  let corpus: { reachable: boolean; hits: number; sources: string[] } | null = null;
  if (hasKbCredentials()) {
    console.log(bar('CORPUS REACHABILITY CONTROL'));
    corpus = await probeCorpus();
    if (corpus.reachable) {
      console.log(
        `PASS  full-privilege control retrieved ${corpus.hits} chunk(s) across ` +
        `${CONTROL_QUERIES.length} ordinary queries` +
        (EVAL_INSTITUTION_ID ? `  (institution ${EVAL_INSTITUTION_ID})` : '  (GLOBAL documents only)'),
      );
    } else {
      console.log(
        'FAIL  a full-privilege caller retrieved NOTHING for any control query.\n' +
        '      The harness cannot see the corpus, so no abstention result below is meaningful.\n' +
        (EVAL_INSTITUTION_ID
          ? `      EVAL_INSTITUTION_ID=${EVAL_INSTITUTION_ID} — is that the right tenant?\n`
          : '      No EVAL_INSTITUTION_ID set, so only GLOBAL documents are visible.\n') +
        '      Run with --corpus to see which institutions and namespaces actually hold vectors.',
      );
    }
  }

  const kb          = await runKbCases();
  const suggestions = await runSuggestionCases();
  const entitlement = await runEntitlementCases();
  await runCascadeCases();
  await runRegistryReconciliation();

  console.log(bar('SUMMARY'));
  const platformOk = report('Platform documentation tier', platform);
  if (kb && kb.judges.length > 0) {
    const rerankRuled = kb.judges.includes('rerank');
    console.log(
      `\nRelevance judge   ${kb.judges.join(' + ')}` +
      (rerankRuled ? '' : '   ← CROSS-ENCODER DID NOT RULE'),
    );
    if (!rerankRuled) {
      // Not a footnote. Every KB figure below was produced without the mechanism
      // the abstention numbers depend on, and is not comparable with a run where
      // it ruled.
      console.log(
        '  Every knowledge-base figure below was judged by EMBEDDING SIMILARITY alone.\n' +
        '  config.ts records why that matters: in-domain (0.694-0.808) and out-of-domain\n' +
        '  (0.611-0.744) scores OVERLAP, so no threshold separates them and out-of-domain\n' +
        '  probes get answered. Expect degraded abstention and a cascade that never falls\n' +
        '  through to the news, web or platform tiers.\n' +
        '  Either RERANK_ENABLED is unset (it defaults to FALSE) or reranking failed and\n' +
        '  fell soft to embedding order. Do not compare these numbers with a reranked run.',
      );
    }
  }

  const kbOk       = report('Knowledge base tier', kb);

  // An abstention score computed against an invisible corpus is not a result.
  // Say so where the number is printed, not in a footnote further down.
  if (kb && corpus && !corpus.reachable && kb.summary.abstentionCases > 0) {
    console.log(
      '  ⚠ ABSTENTION UNVERIFIED — the control above retrieved nothing, so these\n' +
      '    cases passed by returning nothing from a corpus the harness cannot see.\n' +
      '    They do not demonstrate that abstention works.',
    );
  }

  // A broken chip is user-visible on the very first screen, so this does NOT
  // wait for --strict. It is gated on corpus reachability instead: when the
  // harness cannot see the corpus, every chip "fails" for a reason that is not
  // a defect, and a guard that cries wolf gets switched off.
  let suggestionsOk = true;
  if (suggestions) {
    console.log('\nSuggestion chips');
    console.log(`  checks         ${suggestions.checks} (one per role each chip is shown to)`);
    if (suggestions.checks === 0) {
      console.log('  INCONCLUSIVE — no chip was actually exercised.');
    } else if (suggestions.failures.length === 0) {
      console.log('  every shipped chip is answerable for every role it is offered to');
    } else if (corpus && !corpus.reachable) {
      console.log(
        `  ${suggestions.failures.length} failure(s), but UNVERIFIED — the corpus is not\n` +
        '  reachable by this harness, so these are not evidence of a broken chip.\n' +
        '  Fix reachability first (run with --corpus).',
      );
    } else {
      suggestionsOk = false;
      console.log(`  ${suggestions.failures.length} BROKEN PROMISE(S):`);
      for (const f of suggestions.failures) console.log(`    - ${f}`);
      console.log(
        '\n  Each line is a chip a user can click that will answer with "I have no\n' +
        '  verified information". Either ingest a document that answers it, or remove\n' +
        '  the chip from suggestions.catalogue.json — do not relax the assertion.',
      );
    }
  }

  let entitlementOk = true;
  if (entitlement) {
    console.log('\nEntitlement');
    console.log(`  cases          ${entitlement.casesWithResults}/${entitlement.totalCases} returned results`);
    console.log(`  chunks checked ${entitlement.chunksInspected}`);
    if (entitlement.vacuousCases.length > 0) {
      // Surfaced in the summary as well as inline: a reader who skims to the
      // bottom must not carry away "no violations" without this attached to it.
      console.log(
        `  vacuous        ${entitlement.vacuousCases.length}/${entitlement.totalCases} ` +
        `case(s) assert only about EMPTY namespaces — not evidence`,
      );
    }
    if (entitlement.chunksInspected === 0) {
      // Every case returned nothing, so nothing was actually verified. Saying
      // "PASS" here would be the most dangerous possible output: a security
      // check reporting green having examined nothing.
      console.log('  INCONCLUSIVE — no chunks were returned, so no entitlement was verified.');
      console.log(
        corpus?.reachable
          ? '    The corpus IS reachable at full privilege, so these restricted callers\n' +
            '    were legitimately shown nothing. That is consistent with correct gating\n' +
            '    but does not prove it — widen the queries or add a document these roles\n' +
            '    can see to get a positive verification.'
          : '    The corpus is not reachable by the harness at all — fix that first\n' +
            '    (run with --corpus), then this tier can verify anything.',
      );
    } else if (entitlement.failures.length === 0) {
      console.log(`  no violations — every returned chunk was within its caller's entitlement`);
    } else {
      entitlementOk = false;
      console.log(`  ${entitlement.failures.length} VIOLATION(S):`);
      for (const f of entitlement.failures) console.log(`    - ${f}`);
    }
  }

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

  // An entitlement violation fails the run REGARDLESS of --strict. Retrieval
  // quality is a tuning target; leaking a document to a caller who may not see
  // it is a security defect, and a security defect must never be reported as a
  // warning that a passing exit code contradicts.
  if (!entitlementOk) {
    console.error('\nFAILED: entitlement violation — a caller received a document outside their access.');
    process.exit(1);
  }

  if (!suggestionsOk) {
    console.error('\nFAILED: a shipped suggestion chip is no longer answerable.');
    process.exit(1);
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
