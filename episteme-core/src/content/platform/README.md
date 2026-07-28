# Platform documentation corpus

Markdown files in this tree are the **product** documentation Episteme answers
from when a user asks about the system itself rather than about their
institution.

**These files are the corpus.** They are read directly from disk at request
time — there is no ingestion step, no vector index, and nothing to run after
editing one. Change a file, deploy, and the answer changes.

## Why not Pinecone

A vector copy would be a second source of truth, and keeping it aligned needs a
lockfile, a content hash, a CI guard and a deploy step — machinery that exists
only to manage drift that otherwise does not exist. Worse, if that deploy step
ever silently fails, the symptom reaching the user is *"no verified
information"*, which is indistinguishable from the system being broken.

The staleness model also does not apply. It assumes a document describes a world
that changes independently of the code — *"this handbook is from 2022, verify
with the relevant office."* Platform docs describe the code itself: there is no
office to verify with, and a wrong doc is a bug to fix, not a caveat to display.
Routed through the KB path, a year-old platform doc would have been flagged
stale and diverted to UNIBEN news and web search.

The corpus is small, self-authored and structured, so section-level lexical
ranking over our own headings is sufficient and fully deterministic.

**Revisit this if the corpus grows past roughly twenty documents**, or starts
fielding questions whose wording shares few words with the headings. That is
where lexical ranking degrades and embedding starts to earn its cost.

## Layout

```
help/   → platform-help   namespace. How to USE Episteme. Everyone, all tiers.
admin/  → platform-admin  namespace. How to OPERATE it. Trust 4 + platform-admin bit.
```

Put a file in `admin/` only if it describes an action the reader takes as an
operator of the platform. Anything a student, parent, or lecturer might ask
belongs in `help/`.

The **directory is authoritative** for the namespace — the `namespace:` field
must agree with it, and a mismatch is a hard error. Trusting the frontmatter
alone would let a typo publish an operator runbook to every user.

## Frontmatter

| Field | Notes |
|---|---|
| `docId` | Stable and globally unique. Duplicates are a hard error. |
| `title` | Human-readable; used as the citation title. |
| `namespace` | `platform-help` or `platform-admin`. Must match the directory. |
| `roles` | Retrieval roles that may match. All five for `help/`; staff/hod for `admin/`. |
| `updated` | ISO date. Editorial metadata only — it drives no runtime behaviour. |

## Writing for retrieval

Sections are split on `##` headings and ranked with BM25, gated by term
coverage. Two consequences worth knowing:

**Headings carry most of the weight.** A section qualifies mainly by matching
the query in its own heading, so write headings as the thing a user would ask —
"Onboarding users and setting access levels" beats "User management".

**Beware university vocabulary in examples.** These docs explain platform
concepts using institutional examples, and terms like *fees*, *students* and
*level* appear incidentally. A body mention alone will not capture an
institutional question (heading-anchoring exists precisely to stop that), but
keep such examples out of headings.

## Verifying a change

```bash
pnpm test   # parses and validates every file, and runs the real-corpus
            # retrieval tests in tools/platform-docs-tier.test.ts
```

Those tests assert that platform questions resolve, that institutional questions
fall through to the knowledge base, and that `platform-admin` content never
reaches a caller without both trust 4 and the platform-admin bit. No credentials
required.
