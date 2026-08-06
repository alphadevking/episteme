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
| `keywords` | Optional list. Words a reader uses for this page that the page never writes. |

`keywords` exist because ranking is lexical: a query term must literally appear
somewhere in the section. *"What are your capabilities"* scored zero against a
page that explains capabilities at length but never uses the word, so the
assistant abstained on a question about itself. Keywords are ranked as **heading
terms** — they are the author asserting what the page answers to — and are never
shown to the model or cited. Add the reader's vocabulary, not more of ours.

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

## Deployment — these files must be copied into the build

**`mastra build` bundles JavaScript and copies nothing else.** Without an
explicit step, this entire tree is absent from the deployed function and the
platform tier answers *nothing* — while every local test passes, because in
development the files are simply there. That is not hypothetical: it is what
production did, and the symptom was the assistant abstaining on *"what can this
assistant do"* on the deployed site only.

Two things keep it fixed:

- `vercel.json` copies `src/content` next to the function entrypoint. If you
  change the build command, keep that copy. It is load-bearing, not tidying.
- `loadPlatformDocs` **throws** when it finds zero documents, and the tier logs
  `CORPUS FAILED TO LOAD` with every path it checked. An empty corpus is a
  broken deployment, never a valid state — the original bug survived because it
  was silent, so silence is now impossible.

`platform-docs-tier.ts` tries several content roots (dev layout, bundled layout,
cwd-relative) and uses the first that exists, so a deployer layout change
degrades to a loud error rather than a wrong answer.

## Verifying a change

```bash
pnpm test   # parses and validates every file, and runs the real-corpus
            # retrieval tests in tools/platform-docs-tier.test.ts
```

Those tests assert that platform questions resolve, that institutional questions
fall through to the knowledge base, and that `platform-admin` content never
reaches a caller without both trust 4 and the platform-admin bit. No credentials
required.
