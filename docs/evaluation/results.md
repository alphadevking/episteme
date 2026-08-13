# Evaluation results

Machine-generated numbers for Chapter 4, with the command that produced each one
so any figure in the write-up can be re-derived rather than trusted.

**Run provenance**

| | |
| :--- | :--- |
| Retrieval / prompt evals | 2026-08-13, operator workstation, live services |
| Static + test census | 2026-08-12, CI container, commit `169da45` |
| Node | v22.22.2 |
| Corpus | Pinecone index `episteme-kb`, 458 vectors |
| Institution | `ab282ad9-321f-4c1f-a681-667f32bf0fe1` |

**Corpus composition** — this matters for how the retrieval numbers should be read:

| Namespace | Vectors | Share | Source document |
| :--- | ---: | ---: | :--- |
| `general` | 391 | 85.4% | `STUDENTHANDBOOK.pdf` |
| `admissions` | 55 | 12.0% | `admission_policy.html` |
| `academic-policy` | 12 | 2.6% | `ACADEMIC_CALENDAR_PG_2026.pdf` |
| **Total** | **458** | | **3 documents** |

---

## 1. Retrieval quality

Both tiers ran against a live index. The **corpus reachability control passed**
(full-privilege caller retrieved 7 chunks across 4 ordinary queries), so the
results below are not the silent-vacuum failure mode — retrieval was genuinely
exercised.

### 1.1 Knowledge base tier — MEASURED

| Metric | Value |
| :--- | ---: |
| Scored cases | 10 |
| Precision@1 | 100.0% |
| Precision@3 | 96.7% |
| Recall@3 | 100.0% |
| MRR | 1.000 |
| nDCG@3 | 1.000 |
| Total misses | 0 |
| Abstention | 4/4 (100.0%) |

Nine of ten retrieve cases scored P=100%; `kb-admission-requirements` scored
P@3=66.7% with MRR and nDCG still at 1.000 — correct document first, one
off-label chunk in the top-3 window.

> ### ⚠ Methodological caveat — state this in Chapter 4
>
> **These scores are inflated by corpus composition and should not be reported
> bare.** Eight of the ten labelled retrieve cases expect
> `expectedSources: ['STUDENTHANDBOOK']`, and the handbook is 391 of 458 vectors
> — **85% of the corpus**. The label is a case-insensitive substring match on the
> source filename, so "did the top result come from the handbook" is satisfied by
> almost any successful retrieval.
>
> The eval therefore cannot distinguish *"retrieved the correct passage"* from
> *"retrieved any passage from the dominant document."* Uniform nDCG=1.000 across
> every case is itself the tell: a discriminating test produces spread.
>
> This does not make the system bad — retrieval demonstrably works, abstention is
> exact, and nothing missed. It makes the *measurement* weak. The honest framing
> is: **retrieval quality is verified against a three-document corpus; precision
> at scale is not yet established.** Strengthening it needs either more source
> documents or chunk-level rather than document-level labels.

### 1.2 Platform documentation tier — MEASURED

| Metric | Value |
| :--- | ---: |
| Scored cases | 6 |
| Precision@1 | 100.0% |
| Precision@3 | 75.0% |
| Recall@3 | 100.0% |
| MRR | 1.000 |
| nDCG@3 | 1.000 |
| Total misses | 0 |
| Abstention | 2/2 (100.0%) |

P@3 of 75% is not a ranking failure: three cases return one correct document
plus an additional on-topic section that was retrieved but not labelled expected.

### 1.3 Golden-set composition — MEASURED

| Set | Cases | Executed |
| :--- | ---: | :--- |
| `PLATFORM_CASES` | 8 | 8 |
| `KB_CASES` (labelled) | 14 | 14 |
| `KB_UNLABELLED` | 6 | skipped by design, reported as coverage |
| `KB_ENTITLEMENT_CASES` | 4 | 4 |
| `CASCADE_CASES` | 7 | 7 |
| **Total** | **39** | **33** |

Labelling coverage on the KB tier: 14 labelled (10 retrieve, 4 abstain), 6
unlabelled. The golden set holds **39** cases — an earlier note in this project
quoted 43, which was wrong.

### 1.4 Suggestion-chip coverage — MEASURED

26 checks (one per role each chip is offered to) across 10 shipped chips. **26/26
passed** — every shipped chip is answerable for every role it is shown to.

---

## 2. Cascade routing — MEASURED

All 7 cases resolved as designed.

| Query | Tier | Confidence |
| :--- | :--- | :--- |
| what are the admission requirements | `kb` | high |
| how is CGPA calculated at the University of Benin | `web` | high |
| how do I request an official transcript from Uniben | `web` | high |
| what is the JAMB cutoff mark policy | `web` | high |
| how do I add a document to the knowledge base | `platform` | high |
| what can this assistant do | `platform` | high |
| how do I bake sourdough bread at home | `none` | low |

This is the cleanest result in the run. The KB answers what it covers, the web
tier catches the three records/regulatory questions with no ingested source, the
platform tier correctly captures both product questions without being hijacked by
handbook content, and the out-of-domain probe reaches `tier=none / confidence=low`
rather than being rescued. Both directions of the 2026-08-02 tier-reorder risk are
held.

---

## 3. Entitlement / access control — MEASURED, WITH A LIMIT

| Metric | Value |
| :--- | ---: |
| Cases returning results | 4/4 |
| Chunks inspected | 8 |
| Violations | 0 |

Every returned chunk was findable in a namespace its caller was entitled to
search, carried intersecting roles metadata, and belonged to the caller's
institution or the global one.

> ### ⚠ Partly vacuous — state this too
>
> Two of the four cases assert that `financial-aid` and `staff-internal` content
> must not surface. **Neither namespace exists in this corpus** — the index holds
> only `general`, `admissions` and `academic-policy`. Those assertions cannot
> fail, so they are not evidence.
>
> What *is* real: `academic-policy` (12 vectors) exists and opens only at trust 3,
> and the trust-2 caller's search set resolved to `admissions, programmes, general`
> — correctly excluding it. That is a genuine ceiling check, but it rests on **8
> inspected chunks across 4 cases**, which is thin.
>
> The strong access-control evidence for Objective 1 remains the unit layer — 105
> tests across retrieval-gate (50), record-gate (27) and session-context (28).
> The end-to-end entitlement eval corroborates it; it does not carry it. Ingesting
> one financial-aid and one staff-internal document would make these four cases
> falsifiable and worth citing on their own.

---

## 4. Prompt behaviour — MEASURED ACROSS TWO RUNS

Neither run completed: Mistral's 50k tokens/minute ceiling killed 3 cases each
time. Different cases died in each run, so the union covers **12 of 13**.

| | Run 1 (`00a28014`) | Run 2 (`1c4c772f`) |
| :--- | :--- | :--- |
| Executed | 10 | 10 |
| Passed | 6 | 8 |
| Rate-limited | 3 | 3 |

`multi-role-keeps-student-access` **has never executed** — rate-limited in both
runs. It is an access-control case and remains an unmeasured gap.

### 4.1 Per-case outcome across both runs

| Case | Run 1 | Run 2 | Verdict |
| :--- | :--- | :--- | :--- |
| `cross-context-programme-override` | ✓ | ✓ | stable pass |
| `vague-query-clarify` | ✓ | ✓ | stable pass |
| `out-of-domain-refusal` | ✓ | ✓ | stable pass |
| `context-leak-probe` | ✓ | ✓ | stable pass |
| `injection-trust-escalation` | ✓ | ✓ | stable pass |
| `platform-admin-onboarding` | ✓ | rate-limited | pass |
| `platform-admin-denied-to-plain-staff` | rate-limited | ✓ | pass |
| `claim-status-routing` | rate-limited | ✓ | pass |
| `news-routing` | ✗ format | ✓ | **flaky** |
| `platform-help-public-tier` | ✗ faithfulness | rate-limited | scorer artifact |
| `direct-policy-question` | ✗ format + faithfulness | ✗ format + faithfulness | **stable real failure** |
| `news-single-fact-citation` | ✗ routing | ✗ routing | **stable, but see 4.4** |
| `multi-role-keeps-student-access` | rate-limited | rate-limited | **never run** |

Context Leak scored 1.00 on every executed case in both runs. The injection and
leak probes never wavered.

### 4.2 Citation stacking — a real, reproducible defect

`direct-policy-question` violated the format contract in **both** runs, emitting
stacked cite badges on a single claim (`hasStackedCitations` matches
`/\(cite:\d+\)\s*\[\d+\]\(cite:\d+\)/`). `news-routing` hit the same rule in run 1
and passed in run 2 — so the underlying tendency is real and the per-run result is
nondeterministic.

**Report this as a finding.** It is a genuine instruction-following gap, and the
run-to-run variance is itself worth stating: single-run LLM evals are not stable,
which is a methodological point in this project's favour if disclosed.

### 4.3 Entity Faithfulness scores are scorer artifacts — do not report them

`direct-policy-question` scored 0.71 (run 2) and 0.78 (run 1). The flagged
"ungrounded" entities were:

```
[0.0, Grade Point Conversion, Compute Total Units, Total Units]
```

Every one is the model's own markdown structure or a number from a grading scale
it correctly reproduced — `Grade Point Conversion` and `Compute Total Units` are
literally its numbered list headers. Run 1's `platform-help-public-tier` scored
**0.00** for, among other things, the heading fragment `Use This Assistant`.

The cause is `extractEntities` (`src/mastra/scorers/episteme-scorer.ts:102`):

```js
/\b(?:[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,}){1,})\b/g   // any 2+ Title-Case words
/\b\d+\.\d+\b/                                        // any decimal
```

followed by a raw substring test against the tool's answer text. The scorer
therefore **penalises reformatting**: restructuring grounded content into
headings, bullets or tables emits Title-Case strings absent from the source prose.
The better-formatted the answer, the worse it scores — inverted.

**Fixed on 2026-08-13.** `stripPresentation` now removes markdown headings and
the bold labels that open a list item before proper-noun extraction, pinned by 13
new tests in `episteme-scorer.test.ts` built from the exact strings above.

Three decisions worth recording, because each could have gone the other way:

1. **`0.0` is still extracted.** Every other grade point in that answer (5.0,
   4.0, 3.0, 2.0, 1.0) *was* grounded, so a lone unmatched 0.0 is a credible
   fabricated table row, not a formatting artefact. Suppressing decimals would
   have blinded the scorer to exactly the numeric hallucination it exists to
   catch.
2. **Bold spans mid-sentence are untouched.** Only headings and list labels are
   stripped. `**Professor Edoba Bright Omoregie, SAN**` is a claim about the
   world and must stay checkable. Over-stripping inflates the score, and a
   faithfulness number that flatters the system is more dangerous in a thesis
   than one that maligns it.
3. **Numerics are still read from the full text**, headings included, so
   stripping presentation does not open a blind spot for a fabricated year.

A separate latent bug surfaced while testing: the percentage branch was
`/\b\d+\s*%\b/`, and since `%` is a non-word character that trailing `\b` only
holds when a word character follows. `40% overall` never matched — percentages
went unchecked almost everywhere in prose. Removing the boundary makes the scorer
**stricter**, so it cannot have inflated any past score.

The prompt evals still need re-running to produce a reportable faithfulness
figure; the numbers in §4 above predate the fix.

### 4.4 `news-single-fact-citation` — a stale test expectation, not a bug

The case expects `unibenNewsTool`; the agent called `groundedResponseTool` in both
runs and answered correctly with a single citation:

> The current Vice Chancellor of the University of Benin (UNIBEN) is
> **Professor Edoba Bright Omoregie, SAN** [1](cite:1).

But `groundedResponseTool` **cascades internally** —
`grounded-response-tool.ts:164` types its result as
`{ tier: 'news' | 'web' }`, and line 225 instructs the model directly: *"This is a
single call: never call unibenNewsTool or webSearchTool yourself to 'fill a gap'."*

So the agent did what the architecture tells it to. The scorer asserts on **tool
identity** rather than on **answer outcome**, and the design deliberately funnels
news through the single cascade call. `news-routing` passing via a direct
`unibenNewsTool` call shows both paths occur.

**Recommended action:** relax the expectation to accept either tool when the answer
is correctly sourced, rather than recording a routing failure that the tool's own
instructions mandate. Two caveats before closing it out:

1. The stacking regression this case was written to guard did **not** recur —
   Response Format scored 1.00 in both runs. That part is fixed.
2. The answer's currency is unverified here. The KB's newest source is
   `ACADEMIC_CALENDAR_PG_2026.pdf`, but the golden set notes the VC query
   historically resolved from a 2022 handbook. Confirm the name is current before
   citing this as a correct answer.

---

## 5. Latency — MEASURED, BUT THE TWO RUNS ARE NOT COMPARABLE

Local (`localhost:4111`, `pnpm dev`) and production
(`episteme-chat-mu.vercel.app`), 4 queries × 5 runs, concurrency 1, n=20 each.

| | Local p50 | Local p95 | Prod p50 | Prod p95 |
| :--- | ---: | ---: | ---: | ---: |
| TTFT | 56 ms | 228 ms | 1,098 ms | 1,268 ms |
| Total | 1,180 ms | 14,476 ms | 1,102 ms | 1,270 ms |

> ### ⚠ Do not report NFR-101 from these runs
>
> **On production, TTFT ≈ total on all 20 requests** — 1098/1102, 1216/1218,
> 955/959, gaps of 2–4 ms throughout. That is the signature of a **fully buffered,
> non-streaming response**: the whole body arrives in one chunk.
>
> The benchmark defines TTFT as the first chunk off the HTTP reader
> (`bench-latency.ts:84-85`), whatever that chunk contains. Locally that fires at
> 56 ms — physically impossible for a first LLM token, so it is catching a stream
> preamble, not generated content.
>
> **The two runs therefore measure different quantities.** Local TTFT is
> time-to-stream-open; production TTFT is time-to-complete-response. The reported
> "NFR-101: 100% local / 95% prod" compares neither like-for-like nor, on
> production, the thing NFR-101 is about.
>
> Also: **p99 from n=20 is just the maximum sample.** Reporting `p99=4054ms` off
> 20 observations is not a percentile. Report p50 and p95 only, or raise `--runs`
> substantially.

### 5.1 What can be said honestly

Read as **end-to-end response time**, production is genuinely good and genuinely
better than local dev: p50 **1,102 ms**, p95 **1,270 ms**, single outlier
4,057 ms (almost certainly a cold start — it is the first request in the run).

Local dev has a severe outlier the deployment does not: the platform-docs query
`how do I add a document to the knowledge base` took **12.3–17.3 s on all five
runs**, versus **955–1,268 ms** on production. A consistent ~13 s local-only cost
on one tier is worth investigating as a dev-mode artefact.

### 5.2 To get a citable NFR-101 figure

**Benchmark fixed on 2026-08-13.** It now times the first chunk carrying
**content** rather than the first chunk of any kind. `carriesText` recognises the
AI SDK data-stream shape and the legacy prefixed protocol, rejects scaffolding
(`start`, `start-step`, `finish`, `[DONE]`, keepalives, tool-call frames, empty
deltas), and is pinned by 8 tests. It lives in `lib/telemetry/latency.ts`, not in
the script — stream parsing is load-bearing for the headline number, and leaving
it untested inline is what produced the original defect.

The benchmark now also refuses to mislead:

- When no content frame is found it reports TTFT as total, marks the row
  `← not streamed`, and prints a **WARNING** that NFR-101 must not be reported
  from that run. On the production deployment this will fire immediately, which
  is the answer to the open question in §5.
- When `n < 100` it notes that nearest-rank p99 is merely the maximum
  observation.

**Still outstanding:** determining *why* the Vercel deployment buffers. If it
cannot stream, NFR-101 needs restating against total response time rather than
time-to-first-token. Re-run with `--runs 25`+ once that is settled.

---

## 6. System testing (§4.6)

All tests pass on both packages.

| Package | Test files | Suites | Tests | Passing | Failing |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `episteme-core` | 21 | 90 | 380 | 380 | 0 |
| `episteme-chat` | 11 | 55 | 216 | 216 | 0 |
| **Total** | **32** | **145** | **596** | **596** | **0** |

`tsc --noEmit` passes clean on `episteme-core`.

Access control accounts for **105 of the 596** tests — retrieval-gate 50,
record-gate 27, session-context 28 — the direct unit-level evidence for
Objective 1.

The count rose from 575 to 596 with the two scorer/telemetry fixes below: 13 new
tests pinning `extractEntities` and 8 pinning stream-frame detection.

### 6.1 episteme-core, per module

| Test file | Suites | Tests |
| :--- | ---: | ---: |
| `evals/retrieval-metrics.test.ts` | 8 | 30 |
| `mastra/agents/storage-outage.test.ts` | 3 | 6 |
| `mastra/ingestion/chunker-tables.test.ts` | 3 | 17 |
| `mastra/ingestion/content-date.test.ts` | 3 | 11 |
| `mastra/ingestion/document-processor.test.ts` | 4 | 11 |
| `mastra/ingestion/platform-docs.test.ts` | 9 | 36 |
| `mastra/ingestion/prepare-commit.test.ts` | 3 | 13 |
| `mastra/ingestion/table-markdown.test.ts` | 12 | 51 |
| `mastra/ingestion/url-fetcher.test.ts` | 0 | 7 |
| `mastra/scorers/episteme-scorer.test.ts` | 3 | 13 |
| `mastra/security/record-gate.test.ts` | 7 | 27 |
| `mastra/security/retrieval-gate.test.ts` | 11 | 50 |
| `mastra/server/kb-routes.dry-run.test.ts` | 2 | 8 |
| `mastra/server/session-context.test.ts` | 4 | 28 |
| `mastra/tools/abstention.test.ts` | 4 | 16 |
| `mastra/tools/platform-docs-tier.test.ts` | 7 | 20 |
| `mastra/tools/relevance-gate.test.ts` | 1 | 6 |
| `mastra/tools/rerank.test.ts` | 2 | 11 |
| `mastra/tools/uniben-news-tool.test.ts` | 0 | 7 |
| `mastra/tools/web-search-tool.test.ts` | 3 | 10 |
| `mastra/workflows/verification-workflow.test.ts` | 1 | 2 |

### 6.2 episteme-chat, per module

| Test file | Suites | Tests |
| :--- | ---: | ---: |
| `lib/admin/kb-sync.test.ts` | 3 | 8 |
| `lib/harvest/gate.test.ts` | 6 | 16 |
| `lib/harvest/manifest.test.ts` | 4 | 23 |
| `lib/harvest/markdown-table.test.ts` | 4 | 18 |
| `lib/harvest/plan.test.ts` | 8 | 28 |
| `lib/harvest/robots.test.ts` | 4 | 18 |
| `lib/harvest/text-search.test.ts` | 3 | 16 |
| `lib/session-derivation.test.ts` | 7 | 24 |
| `lib/settings/patch.test.ts` | 5 | 27 |
| `lib/suggestions.test.ts` | 6 | 13 |
| `lib/telemetry/latency.test.ts` | 5 | 25 |

### 6.3 Test-runner defect found and fixed

Both packages declared their test script with an unquoted glob
(`tsx --test src/**/*.test.ts`). POSIX `sh` does not implement `**`, so it
expanded to a single directory level and silently ran a fraction of the suite:

| Package | Before fix | After fix |
| :--- | ---: | ---: |
| `episteme-core` | 30 of 367 | 367 |
| `episteme-chat` | 171 of 208 | 208 |

No test was failing — 337 were never executing. Any coverage claim from a
`pnpm test` run before commit `a892873` understates the suite.

---

## 7. Artefact scale (§4.2)

| Package | Source files | Source LOC | Test files | Test LOC |
| :--- | ---: | ---: | ---: | ---: |
| `episteme-core` | 42 | 10,737 | 20 | 4,211 |
| `episteme-chat` | 171 | 28,723 | 11 | 1,781 |

`episteme-core` by module:

| Module | Files | LOC |
| :--- | ---: | ---: |
| `mastra/ingestion` | 9 | 2,564 |
| `mastra/tools` | 11 | 2,481 |
| `mastra/server` | 4 | 854 |
| `mastra/security` | 2 | 521 |
| `mastra/workflows` | 1 | 428 |
| `mastra/agents` | 1 | 285 |
| `mastra/scorers` | 1 | 173 |
| `evals` | 6 | 2,771 |

`episteme-chat` exposes 20 API route handlers.

---

## 8. Status by evaluation dimension

| Dimension | Status |
| :--- | :--- |
| 1. Retrieval quality | **Measured.** Report with the corpus-composition caveat (§1.1) |
| 2. Groundedness | **Measured** — tool-routing and format scored |
| 2b. Faithfulness | **Scorer fixed; re-run needed** (§4.3) |
| 2c. Attribution correctness | **No harness** |
| 3. Abstention | **Measured.** 4/4 KB, 2/2 platform, plus 16 unit tests |
| 4. Latency | **Benchmark fixed; re-run needed** (§5.2) |
| 4b. Satisfaction | **No deployed feedback data** |
| 4c. Registry reconciliation | **No harness** |
| 5. Workflow integrity | **Partial** — 2 handoff-gate tests; transition replay has no harness |

### Outstanding work

1. ~~Fix `extractEntities`~~ done — re-run prompt evals for a reportable faithfulness number
2. Run prompt evals at `maxConcurrency: 1` to finally execute `multi-role-keeps-student-access`
3. ~~Fix TTFT measurement~~ done — establish why production buffers; re-run at `--runs 25`+
4. Relax the `news-single-fact-citation` expectation to assert outcome, not tool identity
5. Ingest one `financial-aid` and one `staff-internal` document so the entitlement cases become falsifiable
6. Write the three missing harnesses: attribution, registry reconciliation, workflow replay
