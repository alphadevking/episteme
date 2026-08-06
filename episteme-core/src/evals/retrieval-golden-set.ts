// episteme-core/src/evals/retrieval-golden-set.ts
/**
 * Labelled cases for the retrieval eval.
 *
 * HONESTY RULE FOR THIS FILE: a case is only labelled when the expected answer
 * is verifiable, not guessed. Two kinds qualify today:
 *
 *   1. PLATFORM cases — the corpus is Markdown in src/content/platform, so the
 *      expected document is knowable by reading the repo. Fully labelled below,
 *      and they need no credentials to run.
 *   2. ABSTENTION cases — an out-of-domain query must return nothing, which is
 *      true regardless of what the knowledge base contains. Fully labelled.
 *
 * INSTITUTIONAL retrieve-cases (fees, hostel, deadlines…) cannot be labelled
 * from the repo: the right answer depends on which documents were ingested.
 * Those live in KB_UNLABELLED as real queries with no expectations, and the
 * runner SKIPS them while reporting coverage, so the gap is measured rather
 * than hidden. `pnpm eval:retrieval --label` prints what retrieval currently
 * returns for each, which is the fastest way for someone who knows the corpus
 * to fill them in. Moving a case up into KB_CASES is the whole workflow.
 *
 * A fabricated label is worse than a missing one: it would make the eval
 * confidently wrong and send tuning in the wrong direction.
 */

export type Role = 'prospective' | 'student' | 'parent' | 'staff' | 'hod';

/** A case against the Pinecone-backed institutional knowledge base. */
export interface KbCase {
  id: string;
  query: string;
  /** Primary role. `roles` overrides it when access is the union of several. */
  role: Role;
  roles?: Role[];
  trustLevel?: number;
  institutionId?: string;
  programme?: string;
  level?: string;
  expect: 'retrieve' | 'abstain';
  /**
   * Substrings matched case-insensitively against each result's `source`
   * (a URL or file name). Empty for abstention cases.
   */
  expectedSources: string[];
  /** Why this is the right expectation — makes a label auditable, not folklore. */
  why: string;
}

/** A case against the on-disk platform documentation tier. */
export interface PlatformCase {
  id: string;
  query: string;
  trustLevel?: number;
  /**
   * The platform-operator bit. Fails closed: without it the admin runbook is
   * invisible, which is what the gating cases below assert.
   */
  isPlatformAdmin?: boolean;
  expect: 'retrieve' | 'abstain';
  /** Matched against each returned source's `title`. */
  expectedTitles: string[];
  why: string;
}

// ── Platform tier — labelled from the corpus in src/content/platform ──────────

export const PLATFORM_CASES: PlatformCase[] = [
  {
    id: 'platform-ingest-howto',
    query: 'how do I add a document to the knowledge base',
    trustLevel: 4,
    isPlatformAdmin: true,
    expect: 'retrieve',
    expectedTitles: ['Adding documents to the knowledge base'],
    why: 'Directly the subject of admin/ingesting-documents.md.',
  },
  {
    id: 'platform-onboarding-access',
    query: 'how do I onboard new staff and set their access levels',
    trustLevel: 4,
    isPlatformAdmin: true,
    expect: 'retrieve',
    expectedTitles: ['Onboarding users and setting access levels'],
    why:
      'The Rule 1d case from the agent instructions: a PLATFORM question about ' +
      'creating accounts and assigning roles, not a university HR policy question.',
  },
  {
    id: 'platform-institution-setup',
    query: 'how do I set up my institution in Episteme',
    trustLevel: 4,
    isPlatformAdmin: true,
    expect: 'retrieve',
    expectedTitles: ['Setting up your institution'],
    why: 'Directly the subject of admin/institution-setup.md.',
  },
  {
    id: 'platform-getting-started',
    query: 'what can this assistant do and how do I get better answers',
    trustLevel: 1,
    expect: 'retrieve',
    expectedTitles: ['Getting started with Episteme'],
    why:
      'help/getting-started.md carries both "What it can answer" and "Getting ' +
      'better answers"; the help namespace is visible to every role.',
  },
  /**
   * THE SHORT FORM OF THE SAME QUESTION — the phrasing a user actually types.
   *
   * platform-getting-started above passes because "better answers" matches a
   * heading. Strip the query back to how anyone would really ask it and every
   * word is either grammar or the product's own name, all of which `tokenize`
   * removes as non-discriminating; rankSections then early-returns on an empty
   * term set. The one question every role is guaranteed to be able to ask was
   * unanswerable, while its verbose paraphrase worked — so the chip passed and
   * the typed question failed.
   *
   * Kept as separate cases from the long form deliberately: they exercise the
   * identity fallback, and the long form must keep passing through the ORDINARY
   * ranking path. One case cannot prove both.
   */
  {
    id: 'platform-identity-short',
    query: 'what can this assistant do',
    trustLevel: 1,
    expect: 'retrieve',
    expectedTitles: ['Getting started with Episteme'],
    why:
      'Tokenizes to zero content terms, which is precisely what identifies it: ' +
      'every word was grammar or a product name, so it can only be a question ' +
      'about the product. See IDENTITY_QUERY in platform-docs-tier.ts.',
  },
  {
    id: 'platform-identity-operator',
    query: 'what can this assistant do',
    trustLevel: 4,
    isPlatformAdmin: true,
    expect: 'retrieve',
    expectedTitles: ['Getting started with Episteme'],
    why:
      'The identity fallback is restricted to the help namespace, so an operator ' +
      'asking what the product does gets the same introduction as everyone else ' +
      'rather than the ingestion runbook. Guards the narrowing, which is the part ' +
      'that could silently regress into answering from admin content.',
  },
  /**
   * Access control observed through retrieval rather than through the gate's
   * own unit tests: the operator runbook must not surface for a caller without
   * the platform-admin bit, no matter how well the query matches it.
   */
  {
    id: 'platform-admin-hidden-from-non-operator',
    query: 'how do I add a document to the knowledge base',
    trustLevel: 4,
    isPlatformAdmin: false,
    expect: 'abstain',
    expectedTitles: [],
    why:
      'Same query as platform-ingest-howto but without the operator bit. ' +
      'resolvePlatformNamespaces fails closed, so admin content must be invisible ' +
      'and the help doc must not clear the coverage gate for an admin-only question.',
  },
  {
    id: 'platform-out-of-domain',
    query: 'what is the boiling point of water',
    trustLevel: 4,
    isPlatformAdmin: true,
    expect: 'abstain',
    expectedTitles: [],
    why: 'No platform section covers this; the coverage gate must reject it.',
  },
];

// ── Knowledge base tier — abstention cases are labelled; retrieval cases are not ──

export const KB_CASES: KbCase[] = [
  /**
   * Labelled from corpus inspection (`--corpus`, 2026-08-02): the admissions
   * namespace holds admission_policy.html, which is the document that should
   * answer an admissions question. Re-confirm with `--label` if the corpus
   * changes — a label that no longer matches any source scores zero and looks
   * like a retrieval failure, which the runner calls out explicitly.
   */
  {
    id: 'kb-admission-requirements',
    query: 'what are the admission requirements',
    role: 'prospective',
    trustLevel: 1,
    expect: 'retrieve',
    expectedSources: ['admission_policy'],
    why:
      'admission_policy.html is the admissions-namespace document in this corpus, ' +
      'and admissions is readable at trust 1 by prospective students — so this ' +
      'exercises the ordinary public path end to end.',
  },
  /**
   * Labelled from a `--label` run (2026-08-02, maxScore 0.797 — the strongest
   * score any KB_UNLABELLED query produced).
   *
   * The label is a judgement, not an echo of that output: accommodation
   * procedure is exactly what a student handbook is FOR, so the handbook is the
   * document that *should* answer this, independent of what ranked today. It is
   * also durable content — unlike the fee schedule or the VC's name, an
   * application procedure does not silently expire between editions.
   */
  {
    id: 'kb-hostel-accommodation',
    query: 'how do I apply for hostel accommodation',
    role: 'student',
    trustLevel: 2,
    expect: 'retrieve',
    expectedSources: ['STUDENTHANDBOOK'],
    why:
      'STUDENTHANDBOOK.pdf is the general-namespace document (391 of the corpus\'s ' +
      '454 vectors), and `general` opens at trust 1 — so an unverified student, ' +
      'the most common real caller, can reach it.',
  },
  /**
   * HANDBOOK COVERAGE, labelled from the `--label` run of 2026-08-06.
   *
   * The first probe batch (2026-08-02) asked about fees, registration,
   * transcripts, CGPA and deadlines — all administrative RECORDS questions — and
   * six of seven returned nothing. That produced a badly wrong conclusion, which
   * these cases correct: the corpus is not thin, it is a HANDBOOK. It answers
   * what a handbook answers (conduct, examinations, discipline, services,
   * facilities) and says nothing about what lives in a student records system.
   *
   * Every case below is labelled on that reasoning, not on the score: each is
   * subject matter a student handbook exists to cover, so the handbook is the
   * document that SHOULD answer it however retrieval happens to rank today. All
   * are durable — rules, procedures and services do not silently expire between
   * editions the way a fee schedule or an office-holder's name does, which is
   * why kb-todo-vc stays unlabelled despite retrieving from this same document.
   *
   * Scores at labelling ranged 0.699–0.794; the handbook is dated 2022-12-19.
   */
  {
    id: 'kb-exam-regulations',
    query: 'what are the examination rules and regulations',
    role: 'student',
    trustLevel: 2,
    expect: 'retrieve',
    expectedSources: ['STUDENTHANDBOOK'],
    why:
      'Examination regulations are core handbook content and the strongest-scoring ' +
      'query in the corpus (0.794). Durable: the rules of sitting an exam are not ' +
      'a time-varying fact.',
  },
  {
    id: 'kb-student-conduct',
    query: 'what is the student code of conduct',
    role: 'student',
    trustLevel: 2,
    expect: 'retrieve',
    expectedSources: ['STUDENTHANDBOOK'],
    why:
      'A code of conduct is definitionally handbook content. Reached at trust 2, ' +
      'so an unverified student — the most common caller — gets it.',
  },
  {
    id: 'kb-student-discipline',
    query: 'what happens if a student breaks the rules',
    role: 'student',
    trustLevel: 2,
    expect: 'retrieve',
    expectedSources: ['STUDENTHANDBOOK'],
    why:
      'The consequences side of the same handbook material as kb-student-conduct. ' +
      'Kept as a separate case because it is phrased as a plain-language question ' +
      'rather than by its formal name — that phrasing gap is a real retrieval risk ' +
      'and the lowest scorer of this batch (0.699) is where it would show first.',
  },
  {
    id: 'kb-student-services',
    query: 'what student support services are available',
    role: 'student',
    trustLevel: 2,
    expect: 'retrieve',
    expectedSources: ['STUDENTHANDBOOK'],
    why: 'Student services are standard handbook content and reachable at trust 2.',
  },
  {
    id: 'kb-health-services',
    query: 'what medical and health services are available to students',
    role: 'student',
    trustLevel: 2,
    expect: 'retrieve',
    expectedSources: ['STUDENTHANDBOOK'],
    why: 'Health services are standard handbook content and reachable at trust 2.',
  },
  {
    id: 'kb-library',
    query: 'how do I use the university library',
    role: 'student',
    trustLevel: 2,
    expect: 'retrieve',
    expectedSources: ['STUDENTHANDBOOK'],
    why: 'Library access and rules are standard handbook content.',
  },
  {
    id: 'kb-records-office',
    query: 'which office do I contact about student records',
    role: 'student',
    trustLevel: 2,
    expect: 'retrieve',
    expectedSources: ['STUDENTHANDBOOK'],
    why:
      'Load-bearing for the abstention path, not just for coverage. When the ' +
      'corpus cannot answer a records question (fees, transcripts, CGPA all return ' +
      'nothing), this is the one redirect that resolves to a CITED answer instead ' +
      'of the model naming an office from memory. If this case ever breaks, the ' +
      'abstention path loses its only grounded escalation — see tools/abstention.ts.',
  },
  {
    id: 'kb-pg-calendar-dates',
    query: 'what are the key postgraduate dates for the 2026 session',
    role: 'student',
    trustLevel: 3,
    expect: 'retrieve',
    expectedSources: ['ACADEMIC_CALENDAR_PG_2026'],
    why:
      'The ONLY question the academic-policy namespace can answer: it holds 12 ' +
      'vectors, all of them the PG calendar. Double-gated — trust 3 and ' +
      'postgraduate-specific — so it also guards that the trust ladder still opens ' +
      'that namespace at 3 and not below.',
  },
  {
    id: 'kb-abstain-cooking',
    query: 'how do I bake sourdough bread at home',
    role: 'student',
    trustLevel: 2,
    expect: 'abstain',
    expectedSources: [],
    why: 'Out of domain. Nothing in a university knowledge base should clear the relevance gate.',
  },
  {
    id: 'kb-abstain-general-knowledge',
    query: 'what is the capital of France',
    role: 'prospective',
    trustLevel: 1,
    expect: 'abstain',
    expectedSources: [],
    why: 'General knowledge, not institutional information. Rule 3 territory.',
  },
  {
    id: 'kb-abstain-coding',
    query: 'write a python function that sorts a list of numbers',
    role: 'staff',
    trustLevel: 4,
    expect: 'abstain',
    expectedSources: [],
    why: 'Coding help is explicitly out of domain and must not match any document.',
  },
  {
    id: 'kb-abstain-weather',
    query: 'what is the weather forecast for Benin City tomorrow',
    role: 'student',
    trustLevel: 2,
    expect: 'abstain',
    expectedSources: [],
    why:
      'Time-sensitive external fact with no institutional source. Included because ' +
      'it names a real local place — a weak retriever will match Uniben documents ' +
      'on the location alone.',
  },
];

/**
 * Real queries awaiting labels from someone who knows what is ingested.
 *
 * These are NOT scored. Run `pnpm eval:retrieval --label` to see what retrieval
 * returns for each, then move the case into KB_CASES with the correct
 * `expectedSources` and a `why`. Coverage is reported on every run so this list
 * shrinking is visible progress.
 */
/**
 * OBSERVED STATE, `--label` runs of 2026-08-02 and 2026-08-06 (corpus:
 * admission_policy.html, STUDENTHANDBOOK.pdf, ACADEMIC_CALENDAR_PG_2026.pdf):
 *
 *   retrieved   examinations 0.794, conduct 0.776, library 0.770, PG dates 0.767,
 *               health 0.749, records office 0.734, services 0.725,
 *               discipline 0.699, hostel 0.797   → all promoted to KB_CASES
 *   retrieved   vice chancellor ......... 0.694  → deliberately NOT promoted
 *   nothing     fees / registration / transcript / CGPA / late registration
 *
 * THE FIRST BATCH LED TO A WRONG CONCLUSION, recorded here because the mistake
 * is instructive. It probed only administrative-records questions, six of seven
 * returned nothing, and that was read as "the corpus is nearly empty" — which
 * drove a plan to strip the product back to almost no suggestions. The second
 * batch disproved it: the corpus is a HANDBOOK, and answers handbook questions
 * well. What it genuinely cannot answer is anything held in a student records
 * system, because no such document has been ingested.
 *
 * The lesson for whoever probes next: a miss measures the QUERY's subject
 * against the corpus, not the corpus. Probe across subject areas before
 * concluding anything about coverage.
 *
 * WHY THE MISSES STAY UNLABELLED rather than becoming `expect: 'abstain'`:
 * abstaining is correct *today* only because the document is absent. Labelling
 * it as the expectation would make the eval fail the day someone ingests a fee
 * schedule — reporting a fix as a regression, and encoding a content gap as a
 * requirement. A missing label is honest; a wrong one is corrosive.
 *
 * WHY THE VC CASE IS NOT PROMOTED despite retrieving: the handbook is dated
 * 2022-12-19. It names whoever held the post then, and would be cited with full
 * confidence. Promoting it would assert that answering from a three-year-old
 * document is correct behaviour for a question whose answer changes. Post-holder
 * questions belong to the news/web tier; see the cascade cases.
 */
export const KB_UNLABELLED: Array<Omit<KbCase, 'expectedSources' | 'why'>> = [
  // The first five are RECORDS questions: confirmed to retrieve nothing across
  // both probe batches, because nothing covering a student records system has
  // been ingested. They await a source document, not a label.
  { id: 'kb-todo-fees-200l',        query: 'what are the school fees for 200 level engineering students', role: 'student',     trustLevel: 2, level: '200L', expect: 'retrieve' },
  { id: 'kb-todo-registration',     query: 'when does course registration close',                          role: 'student',     trustLevel: 2,                expect: 'retrieve' },
  { id: 'kb-todo-transcript',       query: 'how do I request an official transcript',                      role: 'student',     trustLevel: 2,                expect: 'retrieve' },
  { id: 'kb-todo-cgpa',             query: 'how is CGPA calculated',                                       role: 'student',     trustLevel: 2,                expect: 'retrieve' },
  { id: 'kb-todo-late-reg',         query: 'what happens if I miss the registration deadline',             role: 'student',     trustLevel: 2,                expect: 'retrieve' },
  // Retrieves, but from a 2022 handbook — see the VC note above.
  { id: 'kb-todo-vc',               query: 'who is the current vice chancellor',                           role: 'prospective', trustLevel: 1,                expect: 'retrieve' },
];

// ── Entitlement cases — access control through the real retrieval path ────────

/**
 * Asserts the security property directly on what retrieval RETURNS, rather than
 * on the pure gate functions (retrieval-gate.test.ts already covers those) or by
 * comparing two callers' result sets.
 *
 * WHY NOT SET COMPARISON: the obvious check — "a restricted caller's results
 * must be a subset of a privileged caller's" — is unsound here. The privileged
 * caller searches MORE namespaces, so RETRIEVAL_MAX_RESULTS truncation can push
 * a legitimately-shared document out of their top-k while it stays in the
 * restricted caller's. That reports a leak where none exists, and a security
 * check that cries wolf gets muted.
 *
 * WHAT IS ASSERTED INSTEAD, per returned chunk:
 *   1. it is findable in a namespace this caller is entitled to search
 *      (a chunk from a forbidden namespace cannot be fetched from an allowed
 *      one, so absence is the detection);
 *   2. its `roles` metadata intersects the caller's verified roles;
 *   3. its `institutionId` is either the caller's or GLOBAL_INSTITUTION.
 *
 * Each is a property of the individual result, so truncation cannot produce a
 * false alarm, and a violation is unambiguously a leak.
 *
 * Queries must ACTUALLY RETRIEVE, or the check examines nothing and passes
 * vacuously. They were originally broad keyword lists on the theory that more
 * terms means more matches; enabling the cross-encoder disproved that — it
 * rejects term soup as not-a-question, and entitlement coverage collapsed from
 * 12 chunks to 1. They are now ordinary questions the corpus demonstrably
 * answers. The runner reports how many chunks it inspected, so if the corpus
 * changes and these stop retrieving, the vacuum is visible rather than silent.
 */
export interface EntitlementCase {
  id: string;
  query: string;
  roles: Role[];
  trustLevel: number;
  institutionId?: string;
  namespaceAllowlist?: string[];
  why: string;
}

export const KB_ENTITLEMENT_CASES: EntitlementCase[] = [
  {
    id: 'entitlement-prospective-public-tier',
    // Natural question, not a keyword salad. The cross-encoder correctly
    // rejects term soup as "not a question", which left this case retrieving
    // nothing and verifying nothing — a security check that examines zero
    // chunks passes vacuously.
    query: 'what are the admission requirements',
    roles: ['prospective'],
    trustLevel: 1,
    why:
      'The least-privileged caller against the broadest possible query. Nothing ' +
      'returned may come from academic-policy, financial-aid or staff-internal, ' +
      'which trust 1 forbids outright.',
  },
  {
    id: 'entitlement-student-trust2',
    query: 'how do I apply for hostel accommodation',
    roles: ['student'],
    trustLevel: 2,
    why:
      'Trust 2 is the unverified student. academic-policy and financial-aid open ' +
      'only at trust 3, so a document from either surfacing here is a ceiling breach.',
  },
  {
    id: 'entitlement-staff-claimed-at-low-trust',
    query: 'what are the admission requirements',
    roles: ['staff'],
    trustLevel: 1,
    why:
      'A claimed staff role at trust 1 — the exact shape the trust ceiling exists ' +
      'to defeat. staff-internal must stay unreachable regardless of the role claim.',
  },
  {
    id: 'entitlement-parent-allowlist',
    query: 'how do I apply for hostel accommodation',
    roles: ['parent'],
    trustLevel: 3,
    namespaceAllowlist: ['admissions', 'general'],
    why:
      'A parent whose link grants neither fee nor academic visibility. The ' +
      'allowlist may only narrow, so financial-aid and academic-policy content ' +
      'must not appear even though trust 3 would otherwise permit them.',
  },
];

// ── Cascade cases — the whole tiered answer path, not just retrieval ─────────

/**
 * Questions that exercise KB → news → web routing.
 *
 * `expectAnswered` means "some tier should produce an answer" — not which one.
 * Which tier is right is environment-dependent (the web tier is allowlisted to
 * uniben.edu and the national regulators), so the eval reports the tier rather
 * than asserting it. `none` on an institutional question is the interesting
 * signal: the cascade ran out of options.
 */
export interface CascadeCase {
  query: string;
  role: Role;
  trustLevel: number;
  /** Operator bit — required for the platform-admin namespace to be visible. */
  isPlatformAdmin?: boolean;
  expectAnswered: boolean;
  /** The tier this SHOULD resolve from, when that is knowable. Reported, not asserted. */
  expectTier?: 'kb' | 'platform' | 'news' | 'web' | 'none';
  why: string;
}

export const CASCADE_CASES: CascadeCase[] = [
  {
    query: 'what are the admission requirements',
    role: 'prospective',
    trustLevel: 1,
    expectAnswered: true,
    why: 'The corpus answers this — expect tier=kb. A miss here means retrieval regressed.',
  },
  {
    query: 'how is CGPA calculated at the University of Benin',
    role: 'student',
    trustLevel: 2,
    expectAnswered: true,
    why:
      'No grading document is ingested, so the KB should miss and the web tier should ' +
      'answer from uniben.edu with the unverified caveat. This is the LMS-assistant ' +
      'path: a real student question the corpus cannot cover yet.',
  },
  {
    query: 'how do I request an official transcript from Uniben',
    role: 'student',
    trustLevel: 2,
    expectAnswered: true,
    why: 'Same shape — a records procedure with no ingested source. Should reach a fallback tier.',
  },
  {
    query: 'what is the JAMB cutoff mark policy for Nigerian universities',
    role: 'prospective',
    trustLevel: 1,
    expectAnswered: true,
    why:
      'National regulatory question — jamb.gov.ng is on the web allowlist, so this is ' +
      'the clearest test that the web tier can resolve at all.',
  },
  /**
   * REGRESSION GUARD for the 2026-08-02 tier reorder. The KB now runs before the
   * platform docs, which fixed institutional questions being captured by a
   * product doc — but it creates the opposite risk: a genuine platform question
   * being captured by handbook content that happens to mention "documents".
   * The relevance gate is what should prevent that, and this is what proves it.
   */
  {
    query: 'how do I add a document to the knowledge base',
    role: 'staff',
    trustLevel: 4,
    isPlatformAdmin: true,
    expectAnswered: true,
    expectTier: 'platform',
    why:
      'Rule 1d: a question about operating Episteme. The KB has no answer for it, ' +
      'so it must fall through to the platform docs rather than be answered from ' +
      'the student handbook.',
  },
  {
    query: 'what can this assistant do',
    role: 'student',
    trustLevel: 2,
    expectAnswered: true,
    expectTier: 'platform',
    why:
      'The help namespace is visible to every role and needs no operator bit. ' +
      'Same reorder risk, from the lowest-privilege side.',
  },
  {
    query: 'how do I bake sourdough bread at home',
    role: 'student',
    trustLevel: 2,
    expectAnswered: false,
    expectTier: 'none',
    why:
      'Out of domain at EVERY tier. tier=none with confidence=low is the correct ' +
      'outcome — the cascade must not rescue a question it should refuse.',
  },
];

/** Cases whose expectations are known and therefore scored. */
export const LABELLED_KB_CASES = KB_CASES;

export interface CoverageReport {
  labelled: number;
  unlabelled: number;
  labelledRetrieval: number;
  labelledAbstention: number;
}

export function kbCoverage(): CoverageReport {
  return {
    labelled:           KB_CASES.length,
    unlabelled:         KB_UNLABELLED.length,
    labelledRetrieval:  KB_CASES.filter((c) => c.expect === 'retrieve').length,
    labelledAbstention: KB_CASES.filter((c) => c.expect === 'abstain').length,
  };
}
