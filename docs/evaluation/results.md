# Evaluation results

Machine-generated numbers for Chapter 4, with the command that produced each one
so any figure in the write-up can be re-derived rather than trusted.

**Run provenance**

| | |
| :--- | :--- |
| Date | 2026-08-12 |
| Commit | `169da45` |
| Node | v22.22.2 |
| Environment | CI container, no service credentials present |

**Credential state.** This run had no `PINECONE_API_KEY`, `MISTRAL_API_KEY`,
`TAVILY_API_KEY`, `LIBSQL_*` or Supabase credentials, and no running chat
endpoint. Every harness that needs a live service reports SKIPPED below rather
than a number. Nothing here is estimated or interpolated — a blank is a blank.

---

## 1. Retrieval quality

### 1.1 Platform documentation tier — MEASURED

On-disk Markdown corpus (`src/content/platform`, 5 documents). Needs no
credentials, so these are final numbers.

```
pnpm eval:retrieval
```

| Metric | Value |
| :--- | ---: |
| Scored cases | 6 |
| Precision@1 | 100.0% |
| Precision@3 | 75.0% |
| Recall@3 | 100.0% |
| MRR | 1.000 |
| nDCG@3 | 1.000 |
| Total misses | 0 |

Per-case:

| Case | Expect | P@3 | R@3 | nDCG@3 | Result |
| :--- | :--- | ---: | ---: | ---: | :--- |
| `platform-ingest-howto` | retrieve | 50.0% | 100.0% | 1.00 | PASS |
| `platform-onboarding-access` | retrieve | 50.0% | 100.0% | 1.00 | PASS |
| `platform-institution-setup` | retrieve | 50.0% | 100.0% | 1.00 | PASS |
| `platform-getting-started` | retrieve | 100.0% | 100.0% | 1.00 | PASS |
| `platform-identity-short` | retrieve | 100.0% | 100.0% | 1.00 | PASS |
| `platform-identity-operator` | retrieve | 100.0% | 100.0% | 1.00 | PASS |

Precision@1 and nDCG@3 are perfect: the correct document is ranked first in all
six cases. Precision@3 of 75% is not a ranking failure — three cases return one
correct document plus one additional on-topic section inside a top-3 window, so
the denominator counts context that was retrieved but not labelled expected.

### 1.2 Knowledge base tier (Pinecone) — SKIPPED

Requires `PINECONE_API_KEY`, `PINECONE_INDEX`, `MISTRAL_API_KEY`.

### 1.3 Golden-set composition — MEASURED

Case counts are a property of the repository, so they hold regardless of
credentials.

| Set | Cases | Runs without credentials |
| :--- | ---: | :--- |
| `PLATFORM_CASES` | 8 | yes |
| `KB_CASES` (labelled) | 14 | no |
| `KB_UNLABELLED` | 6 | no — skipped by design, reported as coverage |
| `KB_ENTITLEMENT_CASES` | 4 | no |
| `CASCADE_CASES` | 7 | no |
| **Total** | **39** | 8 executed this run |

Labelling coverage on the KB tier: 14 labelled (10 retrieve, 4 abstain), 6
unlabelled. The unlabelled six are real queries with no verifiable expected
document — five records questions with no ingested source, plus a
vice-chancellor query that resolves only from a 2022 handbook. They are skipped
and counted, not guessed at.

> **Correction to an earlier figure.** The golden set holds **39** cases, not
> the 43 quoted previously. Chapter 4 should say 39, or 22 if quoting only the
> scored labelled cases (8 platform + 14 KB).

### 1.4 Suggestion-chip coverage — MEASURED

Every shipped chip must be answerable for every role it is offered to.

| Metric | Value |
| :--- | ---: |
| Chips in catalogue | 10 |
| Platform-backed checks executed | 11 |
| Passed | 11 (100%) |
| KB-backed checks | skipped (no credentials) |

---

## 2. Groundedness, faithfulness, attribution

**SKIPPED.** `groundedToolUsageScorer` and `faithfulnessScorer` exist in
`src/mastra/scorers/episteme-scorer.ts` and run through `pnpm eval:prompts`,
which calls the live agent and therefore needs `MISTRAL_API_KEY` and the
Pinecone triple.

**Attribution correctness has no harness at all** — nothing yet compares
presented sources against admitted segments. It must be written before Chapter 4
can report it.

---

## 3. Abstention correctness

### 3.1 Platform tier, end to end — MEASURED

| Case | Result |
| :--- | :--- |
| `platform-admin-hidden-from-non-operator` | PASS |
| `platform-out-of-domain` | PASS |
| **Abstention rate** | **2/2 (100.0%)** |

The first is the more interesting one: it is an access-control abstention, not a
topical one. The admin runbook exists in the corpus and is textually a strong
match for the query; it is withheld because the caller lacks the platform-operator
bit.

### 3.2 Abstention logic, unit level — MEASURED

`src/mastra/tools/abstention.test.ts` — 16 tests across 4 suites, all passing.

### 3.3 KB-tier abstention — SKIPPED

The 4 labelled KB abstention cases need credentials. Note for the write-up: the
configuration comments record a prior measurement on a 454-vector corpus where
abstention was 0/4 without cross-encoder reranking and 4/4 with it. That is a
real prior result, but it was measured on 2026-08-02, not in this run, and must
be cited with that date rather than presented as a current figure.

---

## 4. Latency, satisfaction, registry reconciliation

**Latency — SKIPPED.** `pnpm bench:latency` measures time-to-first-token and
stream-completion against a running Mastra endpoint; none was running and no
admin key was set. `pnpm latency:report` aggregates production logs, of which
there were none available here. The pure aggregation logic underneath is covered
by 17 passing tests in `lib/telemetry/latency.test.ts`.

**Satisfaction — NOT AVAILABLE.** Requires feedback rows from deployed usage.

**Registry reconciliation — NO HARNESS.** Nothing yet compares the `kb_documents`
registry against what is actually resident in the Pinecone index. Must be written.

---

## 5. Workflow integrity

**Partially measured.** `src/mastra/workflows/verification-workflow.test.ts`
covers the human-handoff gates — 2 tests, 1 suite, both passing, including
rejection of a malformed resume payload.

**Transition replay has no harness.** Full transition-matrix, SLA and
audit-completeness replay over recorded runs must be written before this
dimension can be reported as covered.

---

## 6. System testing (§4.6)

All tests pass on both packages.

| Package | Test files | Suites | Tests | Passing | Failing | Wall time |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| `episteme-core` | 20 | 87 | 367 | 367 | 0 | 8.4 s |
| `episteme-chat` | 11 | 54 | 208 | 208 | 0 | — |
| **Total** | **31** | **141** | **575** | **575** | **0** | |

`tsc --noEmit` passes clean on `episteme-core`.

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
| `lib/telemetry/latency.test.ts` | 4 | 17 |

Access control accounts for 105 of the 575 tests — 50 retrieval-gate, 27
record-gate, 28 session-context — which is the direct unit-level evidence for
Objective 1.

### 6.3 Test-runner defect found and fixed

Both packages declared their test script with an unquoted glob
(`tsx --test src/**/*.test.ts`). POSIX `sh` does not implement `**`, so it
expanded to a single directory level and silently ran a fraction of the suite:

| Package | Tests run before fix | After fix |
| :--- | ---: | ---: |
| `episteme-core` | 30 of 367 | 367 |
| `episteme-chat` | 171 of 208 | 208 |

Quoting the pattern hands globbing to the Node test runner, which does implement
`**`. Fixed in both `package.json` files in this commit. No test was failing —
337 of them were simply never executing. Any coverage claim made from a
`pnpm test` run before this commit understates the suite.

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

## What is still needed for a complete Chapter 4

**Needs only credentials and a run** — the harness exists:

1. KB-tier retrieval quality (14 labelled cases)
2. Entitlement cases end to end (4 cases)
3. Cascade tier routing (7 cases)
4. Groundedness and faithfulness (`pnpm eval:prompts`)
5. Latency distribution (`pnpm bench:latency` against a running endpoint)

**Needs a harness written first** — nothing measures these today:

6. Attribution correctness — presented sources vs. admitted segments
7. Registry reconciliation — `kb_documents` vs. resident Pinecone vectors
8. Workflow transition replay — transition matrix, SLA, audit completeness

Sections 4.2 through 4.6 can be written now. Section 4.7 can be written for the
platform tier and the test suite now, and completed for the KB tier once items
1–5 have run.
