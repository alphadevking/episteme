# Chapter 4 — Sections 4.1 to 4.6 (draft)

Describes what was built and how it was tested. Every structural claim is derived
from the repository; every performance figure lives in
`docs/evaluation/results.md` and is cross-referenced rather than restated, so the
two documents cannot drift.

**Not included, and cannot be:**

- **Screenshots.** §4.2 needs the chat interface, admin dashboard and claim
  queue. Yours to capture.
- **§4.7 evaluation results.** Written last, against `results.md`.
- **§4.9 comparison with existing systems.** Carries forward from Chapter 2.

---

## 4.1 Introduction

This chapter reports the construction and evaluation of Episteme, the
role-aware grounded retrieval system specified in Chapter 3. It covers the
artefact as built (§4.2–§4.5), the testing regime applied to it (§4.6), the
results of evaluating it against the criteria set out in §3.18 (§4.7), and what
those results mean for the research questions (§4.8).

### 4.1.1 Mapping to the research objectives

| Objective | Implementation | Evaluation |
| :--- | :--- | :--- |
| **1.** Enforce role- and trust-aware access to institutional knowledge | §4.3 | §4.7, dimensions 3 and 5 |
| **2.** Ground responses in verified institutional sources, abstaining where none exist | §4.4 | §4.7, dimensions 1 and 2 |
| **3.** Provide a human-in-the-loop verification workflow | §4.5 | §4.7, dimension 5 |

### 4.1.2 Evaluation approach

Evaluation follows the five dimensions of §3.18, and takes two complementary
forms throughout.

**Deterministic testing** covers logic that can be exercised without a network,
a model, or credentials — access-control policy, chunking, scoring arithmetic,
transition rules. This is where the security properties are established, because
a policy that can only be checked against a live system can only be checked
occasionally.

**Live evaluation** covers behaviour that only exists in the running system —
retrieval quality against a real index, instruction-following by a real model,
latency against a real deployment. These are slower, costlier and less
repeatable, and are treated accordingly: they are scripts rather than tests, and
they never gate a build.

### 4.1.3 A note on what is and is not claimed

Several results in this chapter are reported as limitations rather than
achievements, and that is deliberate. Three in particular shape how the chapter
should be read.

**Not every dimension reached the same evidential strength.** Retrieval,
abstention, grounding and attribution were measured against live services.
Workflow integrity was specified, implemented and unit-tested, but at the time of
writing had almost no execution history — so it is reported as unverified rather
than as passing. A control that has never run cannot be evidenced by the fact
that nothing has gone wrong.

**One requirement was not met.** Latency against the deployed system fell short
of NFR-101, and §4.7 reports the shortfall together with the distribution that
explains it and the defect subsequently found to be causing it.

**One metric was withdrawn during evaluation.** An entity-level faithfulness
proxy was implemented, run, and found to misfire in three independent ways. It is
reported as a methodological finding rather than as a score, because publishing a
number known to be measuring the wrong thing would be worse than publishing none.

This posture — reporting what the evidence supports and no more — is the same one
the evaluation instruments themselves were built to enforce, and §4.6 and §4.7
describe several cases where a harness was corrected after it was found capable
of reporting success without having examined anything.

---

## 4.2 System Implementation

### 4.2.1 Architecture

Episteme is deployed as two cooperating applications with a deliberate
separation of concerns.

| Package | Responsibility | Stack |
| :--- | :--- | :--- |
| `episteme-core` | Retrieval agent, tools, ingestion pipeline, access-control policy | Mastra, TypeScript, Node 22 |
| `episteme-chat` | Web interface, API routes, identity, records | Next.js (App Router), React, Supabase |

The split is along a trust boundary rather than a convenience one.
`episteme-chat` owns identity: it holds the Supabase session, resolves who the
caller is, and decides what they are entitled to. `episteme-core` owns
knowledge: it retrieves, ranks, grounds and abstains. Core never authenticates a
user and chat never touches the vector index.

### 4.2.2 Data stores

Four stores, each chosen for a different property, and their independence is
itself a design decision.

| Store | Holds | Why separate |
| :--- | :--- | :--- |
| **Pinecone** | Document vectors, namespaced | Similarity search at low latency |
| **Supabase (Postgres)** | Users, institutions, verification claims, audit logs, chat threads | Relational integrity and row-level security |
| **LibSQL / Turso** | `kb_documents` ingestion registry | Durable record of what was ingested |
| **Repository** | Platform documentation (Markdown) | Ships with the code; versioned with it |

The registry is deliberately **off the chat path**. If LibSQL is unreachable,
ingestion fails loudly and the admin interface degrades, but chat keeps
answering. Mastra's own runtime store is likewise kept local rather than remote,
because Mastra persists a run before the first step executes — pointing that at
a remote host would place the host's availability directly in the fatal path of
every chat turn.

That independence buys resilience and costs consistency: two systems written by
the same ingestion run can drift apart afterwards with nothing to notice. The
reconciliation harness described in `results.md` §6 exists precisely for that.

### 4.2.3 Module inventory

`episteme-core`, 42 source modules / 10,737 lines:

| Module | Files | LOC | Responsibility |
| :--- | ---: | ---: | :--- |
| `mastra/ingestion` | 9 | 2,564 | Fetch, parse, chunk, embed, upsert, register |
| `mastra/tools` | 11 | 2,481 | Retrieval, grounding, rerank, news, web, abstention |
| `mastra/server` | 4 | 854 | Chat security middleware, KB admin routes |
| `mastra/security` | 2 | 521 | Retrieval gate and record gate |
| `mastra/workflows` | 1 | 428 | Verification workflow |
| `mastra/agents` | 1 | 285 | Agent definition and instructions |
| `mastra/scorers` | 1 | 173 | Runtime grounding scorers |
| `evals` | 9 | — | Evaluation harnesses (see `results.md`) |

`episteme-chat`, 171 source files / 28,723 lines, exposing **20 API route
handlers** across chat, claims, admin/KB, account, and authentication.

### 4.2.4 Deployment

Both applications deploy to Vercel. `episteme-core` runs as a Mastra server;
`episteme-chat` as a Next.js application that calls it server-to-server with a
shared admin key. The browser never addresses `episteme-core` directly, which is
what makes the session-injection model in §4.3 enforceable rather than advisory.

---

## 4.3 Implementation of the Access Control Framework

*Objective 1. Evaluation evidence: `results.md` §3 and §8.*

### 4.3.1 The core principle: identity is injected, never claimed

The single most important property of this design is that **a caller cannot
state who they are.**

`episteme-chat` resolves the Supabase session server-side, derives the retrieval
role and trust level from verified database state, and forwards them to
`episteme-core` as headers alongside a shared admin key:

```
x-episteme-role         resolved retrieval role
x-episteme-roles        full verified role set
x-episteme-trust-level  1-4
```

The chat-security middleware in core rejects any request without the admin key,
so the browser cannot reach core at all. A user who edits a request body, or
instructs the model that they are staff, changes nothing: the model never sees
these values and has no mechanism to alter them. They arrive out of band, in the
`RequestContext`, and the gates read them from there.

This is why the prompt-injection and context-leak probes hold — see `results.md`
§4.1, where Context Leak scored 1.00 on all thirteen cases across all five runs.
The property is structural, not a matter of the model behaving well.

### 4.3.2 Two gates, two different questions

Access control is split because it answers two genuinely different questions.

**The retrieval gate** (`security/retrieval-gate.ts`) answers *which namespaces
may this session search*. Its unit is a namespace; its output is a list.

**The record gate** (`security/record-gate.ts`) answers *which rows may this
session read*. Its unit is a database row, and the same collection is readable
by several roles at different widths — a HOD may read verification claims but
only their department's; a staff member only those assigned to them; a student
only their own.

The record gate does not return a boolean. **It returns a required predicate** —
the filter the caller must apply. A tool cannot forget to scope a query, because
it has nothing to build a query from until the gate hands it a scope. Making the
unsafe call unrepresentable is stronger than reviewing for it.

Both modules are pure: no I/O, no environment reads, no client construction. That
is what allows 105 unit tests to exercise the policy without secrets or a
database.

### 4.3.3 The trust ladder

Namespace resolution is the **intersection** of two tables — role and trust —
and the intersection is where the security lives.

| Trust | Meaning | Namespaces |
| ---: | :--- | :--- |
| 1 | Unverified / prospective | `admissions`, `programmes`, `general` |
| 2 | Unverified student | `admissions`, `programmes`, `general` |
| 3 | Portal-verified student | + `academic-policy`, `financial-aid` |
| 4 | Staff / HOD / superadmin | + `staff-internal` |

Role alone grants little: every non-staff role may reach every namespace except
`staff-internal`. That is intentional and documented in the source — restricting
public institutional content by role adds no confidentiality, only false
negatives. A student excluded from `admissions` could not retrieve the
re-admission policy that squarely concerns them.

The trust ceiling is what carries the weight. **A claimed role of `staff` at
trust 1 resolves to public namespaces only.** This is the exact case the
`entitlement-staff-claimed-at-low-trust` eval exercises.

Three further properties:

- **Fails closed.** An unrecognised role degrades to `prospective`; an
  unrecognised trust level degrades to 1. Never upward.
- **Allowlists narrow only.** A parent's per-family link permissions can
  restrict the resolved set, never extend it.
- **Defence in depth.** `staff-internal` is excluded from non-staff roles *and*
  gated at trust 4, so either check alone would suffice.

### 4.3.4 Platform documentation is gated separately

Product documentation is not institutional content and is not governed by the
tenant's namespaces. `platform-help` is visible to every role; `platform-admin`
requires an explicit operator bit **and** trust 4. The operator bit is a property
of the platform, not of the tenant, and fails closed — without it the admin
runbook is invisible even to a trust-4 caller.

`results.md` §1.2 records this passing as an access-control abstention: the
runbook is a strong textual match for the query and is withheld anyway.

---

## 4.4 Implementation of the Grounded Retrieval Pipeline

*Objective 2. Evaluation evidence: `results.md` §1, §2, §4.*

### 4.4.1 Ingestion

```
URL / upload → fetch → parse → chunk → embed → Pinecone
                                            └→ kb_documents registry
```

Documents enter through the admin interface as a URL or a file. `url-fetcher`
retrieves web sources subject to a robots check; `document-processor` handles
binary formats through Unstructured.io; `table-markdown` preserves tabular
structure that naive text extraction destroys.

**Chunking is parent–child.** Parent chunks of 2,048 characters carry enough
context for the model to reason over; child chunks of 512 are what get embedded
and searched. Retrieval matches on the child and returns the parent — precision
of a small window with the context of a large one.

Every ingested document is recorded in `kb_documents` with its namespace, role
audience, institution, vector count and content date.

### 4.4.2 Retrieval and ranking

```
query → embed → Pinecone top-5 (score ≥ 0.3, gated namespaces)
      → cross-encoder rerank → relevance gate (0.68) → top 3
```

Two-stage ranking, and the second stage is load-bearing. Embedding similarity
alone cannot separate in-domain from out-of-domain queries here: measured scores
overlap (in-domain 0.694–0.808, out-of-domain 0.611–0.744), so **no threshold
exists that separates them.** A cross-encoder reads query and passage together
and judges whether the passage answers the question — which is the signal that
does separate them.

The measured effect is stark. Without reranking, abstention was 0/4 — every
out-of-domain probe was answered from the student handbook, including *"how do I
apply to Harvard University"*. With reranking, 4/4. Reranking fails soft: an
outage falls back to embedding order rather than refusing to answer.

### 4.4.3 Freshness and conflicting sources

Documents carry a content date. Beyond 365 days a source is marked
`staleWarning`, and the context block labels each source as *dated D*, *undated*,
or *dated D — may be outdated*.

The distinction between **undated** and **outdated** is deliberate. Asserting
that something may be outdated is a claim about its age, and an undated source
gives us none. Conflating them would have the model hedge against a document that
might be this morning's.

When sources disagree on a time-varying fact, the context instructs the model to
state **only** the most recently dated value and cite that source — never to
present an older value alongside the newer one. This rule was added after an
observed incident in which the agent answered with a 2022 handbook's former Vice
Chancellor while a current source sat beside it in the same context.
`results.md` §4.6 records that this rule is now covered by 23 tests, having
previously been enforced by prompt instruction alone.

### 4.4.4 The tiered cascade

A single tool call resolves through tiers in order, returning the tier that
answered:

1. **Knowledge base** — the institution's ingested corpus
2. **News** — live posts from the institution's news feed
3. **Web** — allowlisted domains (`uniben.edu`, `nuc.edu.ng`, `jamb.gov.ng`,
   `tetfund.gov.ng`)
4. **Platform documentation** — questions about operating Episteme itself

The cascade is internal to one tool call by design: the model is instructed never
to call the news or web tools separately to fill a gap, which prevents it
assembling an answer from sources the gate never approved.

Live post content is treated as **untrusted data, not instructions** — the
context says so explicitly, and post URLs are withheld from the model entirely.
A model that cannot see a URL cannot paste one, which enforces the
prose/provenance split structurally rather than by instruction.

`results.md` §2 records six of seven cascade cases stable, with one intermittent.

### 4.4.5 Abstention

When no tier clears the relevance gate, the system abstains — and the abstention
is constructed, not generated. `buildAbstentionAnswer` offers refinement options
drawn **only from documents that actually exist** in the caller's reachable
corpus, and never conjures a contact destination.

This matters because a whole category of real question lands here: the corpus is
a student handbook, so records questions — fees, registration, transcripts —
retrieve nothing, and those are among the most-asked. What the abstention says is
what many users actually read.

### 4.4.6 The citation contract

Answers cite inline as `[N](cite:N)`. The client renders its source list from the
**structured** source array the tool returns, never from the model's prose. A
post that instructed the model to mislabel its own source therefore could not
change what the user is shown: provenance travels out of band, the same way
session identity does.

`results.md` §4.3 records the first live measurement of this: zero dangling
citations and zero label/anchor mismatches across thirteen cases. Citation
*coverage*, however, is weak — two high-confidence answers cited nothing at all.

---

## 4.5 Implementation of the Verification Workflow

*Objective 3. Evaluation evidence: `results.md` §7 — and read that section
before writing this one up.*

### 4.5.1 The claim lifecycle

Verification claims move through a five-state machine held in Supabase:

```
pending ──→ in_review ──→ approved
   │            ├───────→ rejected
   └────────────┴───────→ cancelled
```

`pending` may not reach a decision directly. A claim approved without entering
review is one decided without the step the workflow exists to enforce.

Claims are submitted through `fn_submit_verification_claim`, a `SECURITY
DEFINER` routine that resolves the caller, auto-routes academic claims to the
relevant HOD where possible, and writes an audit row atomically. Assignment,
review and reopening each have their own routine.

### 4.5.2 Two representations, one of them auditable

The workflow exists in the codebase twice, and the distinction matters for
evaluation.

`workflows/verification-workflow.ts` models it as a Mastra workflow with five
steps and two suspend points representing the human handoff gates. Its resume
schemas are a trust boundary rather than documentation — Mastra validates the
resume payload, so a malformed admin submission is rejected structurally.

But Mastra persists workflow runs to its **runtime** store, which is deliberately
local and per-instance in production. Nothing durable records those step names.
The auditable record is the Supabase state machine above, with `audit_logs`
supplying actor and timestamp.

An integrity check written against the Mastra step graph would examine zero rows
forever while reporting green. `results.md` §7 documents this being discovered
and corrected.

### 4.5.3 ⚠ The workflow has never been executed

**State of the live database, verified 2026-08-14:** `verification_claims` holds
**zero rows**. `claim_sla_rules` holds zero. `audit_logs` contains no claim
entries of any kind.

The rest of the system has been used — four users, one institution, twelve chat
threads, thirty-seven audit rows for user and knowledge-base actions. The
verification workflow specifically has never been exercised.

**This section must therefore be written as an implementation description, not
an evaluation.** The workflow is built, its integrity rules are specified and
unit-tested, and no execution evidence exists. Claiming otherwise would be
reporting a control that has never run as though it had.

Submitting and resolving a small number of claims through the interface —
including one routed to a second reviewer, and one where self-approval is
deliberately attempted — would convert this from unverifiable to measured. It
would also be the first test of whether the documented audit write actually
fires.

### 4.5.4 Controls specified but not enforced

The integrity rules the replay harness checks — no self-review, dual control,
authority scope, no approval without review — are **detective**. They find a
violation after it happened.

None is enforced at the database layer. `docs/evaluation/proposed/duty-controls.sql`
drafts the preventive constraints, and adding them before real claims exist is
considerably easier than adding them after.

The honest formulation for the chapter: *the system specifies and can detect
these controls; it does not yet prevent them.*

---

## 4.6 System Testing

*Full per-module census: `results.md` §8.*

### 4.6.1 Scale and distribution

| Package | Test files | Suites | Tests | Passing |
| :--- | ---: | ---: | ---: | ---: |
| `episteme-core` | 28 | 125 | 513 | 513 |
| `episteme-chat` | 11 | 55 | 216 | 216 |
| **Total** | **39** | **180** | **729** | **729** |

All pass; `tsc --noEmit` is clean on both packages.

The distribution is more informative than the total, because it records where
risk was judged to sit:

| Area | Tests | Why concentrated here |
| :--- | ---: | :--- |
| Access control | **105** | Objective 1. A leak is unrecoverable |
| Evaluation harnesses | 140 | An instrument that misreports is worse than none |
| Ingestion | 146 | Silent corruption at ingest is invisible downstream |
| Retrieval tiers | 93 | Where grounding is won or lost |
| Other (agent, scorers, admin routes, workflow) | 29 | |

Those five groups sum to 513, the whole of `episteme-core`.

### 4.6.2 Access control is tested without a database

The 105 access-control tests — 50 for the retrieval gate, 27 for the record gate,
28 for session resolution — run with no network, no credentials and no database.

That is a consequence of the design decision in §4.3.2: both gates are pure
functions. They perform no I/O, read no environment, and construct no clients.
Policy is therefore exercised exhaustively and cheaply, on every commit, rather
than occasionally against a live system.

The alternative — asserting access control end to end only — would mean the
security properties were checked only when someone remembered to run an
integration suite with real credentials. §4.7 records why that matters
concretely: the end-to-end entitlement evaluation was found to be partly
unfalsifiable, and the unit layer is what carries Objective 1.

### 4.6.3 Testing what cannot be tested cheaply

Some logic is load-bearing but sits inside modules that cannot be imported
without credentials. The response-context builder is the clearest case: it
attaches the date labels the conflict rule depends on, and it lived in a module
that constructs a vector-store client at import time. Any unit test of it
therefore required live credentials, so it had none — the most consequential
prompt logic in the system was **structurally untestable**.

Extracting it into a pure module made 23 tests possible, covering the labelling
that a stale-source rule cannot work without. This pattern — separating decision
logic from the I/O it is embedded in — recurs throughout, and is why scoring,
policy, ranking arithmetic and transition rules are all testable offline.

### 4.6.4 A defect in the test regime itself

Both packages declared their test script with an unquoted glob:

```
tsx --test src/**/*.test.ts
```

POSIX `sh` does not implement `**`. The pattern expanded to a single directory
level, and the runner silently executed a fraction of the suite — **30 of 367
tests in one package, 171 of 208 in the other.**

Nothing was failing. 337 tests were simply never running, and every green result
reported before the fix understated the suite it claimed to represent.

This is worth reporting rather than quietly correcting, because it is an instance
of the failure mode the evaluation instruments were repeatedly found to share: a
check that reports success without having examined what it claims to cover.
§4.7 documents the same shape in three further places — an access-control
assertion over an empty namespace, a workflow replay over an empty population,
and a retrieval evaluation that would pass if it could see no corpus at all. Each
now carries an explicit guard.

### 4.6.5 What the tests do not cover

Deterministic tests establish that the logic is correct. They cannot establish:

- **Model behaviour.** Whether the agent follows an instruction it was correctly
  given requires a live model — §4.7, dimension 2.
- **Retrieval quality.** Whether the right document is returned depends on the
  corpus, not the code — §4.7, dimension 1.
- **Real-world latency.** Measured against the deployment, not in a test
  process — §4.7, dimension 4.
- **Workflow execution.** Transition rules are unit-tested; whether real claims
  obey them requires real claims — §4.7, dimension 5.

The division is deliberate and is the reason live evaluation runs as scripts
rather than as tests. Each costs real model and retrieval calls and depends on
services outside this system; gating a build on them would produce a suite that
measures a provider's availability rather than this artefact's correctness.
