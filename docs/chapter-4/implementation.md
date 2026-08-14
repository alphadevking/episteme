# Chapter 4 — Sections 4.2 to 4.5 (draft)

Describes what was built. Every claim here is derived from the repository at
commit `b63f42e`; performance figures live separately in
`docs/evaluation/results.md` and are cross-referenced rather than repeated.

**What this draft does not contain**, and cannot:

- **Screenshots.** §4.2 needs the chat interface, admin dashboard and claim
  queue. Those are yours to capture.
- **§4.9 comparison with existing systems.** That carries forward from Chapter 2.
- **Anything about the verification workflow in operation.** It has never run —
  see §4.5.

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
