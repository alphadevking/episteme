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
export const KB_UNLABELLED: Array<Omit<KbCase, 'expectedSources' | 'why'>> = [
  { id: 'kb-todo-fees-200l',        query: 'what are the school fees for 200 level engineering students', role: 'student',     trustLevel: 2, level: '200L', expect: 'retrieve' },
  { id: 'kb-todo-hostel-apply',     query: 'how do I apply for hostel accommodation',                     role: 'student',     trustLevel: 2,                expect: 'retrieve' },
  { id: 'kb-todo-registration',     query: 'when does course registration close',                          role: 'student',     trustLevel: 2,                expect: 'retrieve' },
  { id: 'kb-todo-vc',               query: 'who is the current vice chancellor',                           role: 'prospective', trustLevel: 1,                expect: 'retrieve' },
  { id: 'kb-todo-transcript',       query: 'how do I request an official transcript',                      role: 'student',     trustLevel: 2,                expect: 'retrieve' },
  { id: 'kb-todo-cgpa',             query: 'how is CGPA calculated',                                       role: 'student',     trustLevel: 2,                expect: 'retrieve' },
  { id: 'kb-todo-admission-req',    query: 'what are the admission requirements for computer science',     role: 'prospective', trustLevel: 1,                expect: 'retrieve' },
  { id: 'kb-todo-late-reg',         query: 'what happens if I miss the registration deadline',             role: 'student',     trustLevel: 2,                expect: 'retrieve' },
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
