// episteme-core/src/evals/attribution.ts
/**
 * Attribution correctness — does the answer's citation apparatus hold up?
 *
 * This is §3.18 dimension 2c, and the metric this system uniquely earns the
 * right to report: it already emits [N](cite:N) badges that the client resolves
 * against a structured source list, which most RAG systems do not.
 *
 * ── WHAT THIS MEASURES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────
 *
 * The literature standard here is ALCE-style citation precision and recall:
 *
 *   recall    — fraction of statements ENTAILED by the passages they cite
 *   precision — fraction of citations that actually contribute that support
 *
 * Both require an ENTAILMENT judgement, which no regex can supply. The lesson
 * already paid for in this repo is that substring overlap is not entailment:
 * the faithfulness scorer flagged "70-100%" as unsupported because its source
 * wrote "70 - 100", and flagged an answer's own headings as fabrications. A
 * second string-matching metric wearing ALCE's name would repeat that error
 * with more authority.
 *
 * So this module splits the problem honestly:
 *
 *   STRUCTURAL (here, deterministic, no network, unit-tested) — defects that
 *   are decidable without reading meaning at all. A citation pointing at a
 *   source that does not exist is broken however charitably you read the prose.
 *
 *   SEMANTIC (scoreCitationSupport, needs an EntailmentJudge) — true ALCE
 *   recall and precision. The shape is defined and tested against a stub so
 *   that plugging in an NLI model or an LLM judge is the only remaining work,
 *   but no number is invented in the meantime.
 *
 * Report the structural metrics as structural. Do not call them faithfulness.
 */

/** A [N](cite:M) badge. `label` and `target` differ only when the answer is malformed. */
export interface Citation {
  /** The bracketed number the reader sees. */
  label: number;
  /** The cite: anchor the client resolves. */
  target: number;
}

export interface Statement {
  /** Statement prose with citation badges removed. */
  text: string;
  /** Citations attached to this statement. */
  citations: Citation[];
  /** 0-based position in the answer. */
  index: number;
  /**
   * Whether this statement is expected to carry a citation. False for headings,
   * horizontal rules, bare list labels, and colon-terminated stems that
   * introduce a list — none of which assert anything about the world.
   *
   * This is a HEURISTIC and the only judgement call in the module. Every
   * statement is returned either way, with this flag visible, so a reader can
   * audit the classification instead of trusting it.
   */
  expectsCitation: boolean;
}

export interface AttributionReport {
  statements: Statement[];
  /** Statements where expectsCitation is true. */
  claimCount: number;
  /** Of those, how many carry at least one citation. */
  citedClaimCount: number;
  /** citedClaimCount / claimCount. 1 when there are no claims. */
  citationCoverage: number;
  totalCitations: number;
  /**
   * Citations whose target has no matching source. The badge renders against
   * nothing — an unambiguous defect, no interpretation required.
   */
  dangling: Citation[];
  /**
   * Citations whose visible label disagrees with their cite: anchor, e.g.
   * [2](cite:5). The reader is told one thing and the client resolves another.
   */
  mismatched: Citation[];
  /** Source numbers returned by the tool but never cited in the prose. */
  uncitedSources: number[];
  /** Statements carrying more than one citation — the ALCE precision suspects. */
  multiCited: number;
}

const CITATION_RE = /\[(\d+)\]\(cite:(\d+)\)/g;

/** Heading, horizontal rule, or blank — structure, not assertion. */
function isStructural(line: string): boolean {
  const t = line.trim();
  if (t === '') return true;
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^([-*_])\1{2,}$/.test(t.replace(/\s/g, ''))) return true;
  return false;
}

/**
 * A bare label with no assertion after it:
 *   "1. **Grade Point Conversion**:"      — label alone
 *   "To calculate your CGPA, follow these steps:"  — stem introducing a list
 * Both end in a colon and make no claim of their own; the claims are the items
 * that follow, and those are scored individually.
 */
function isLabelOrStem(text: string): boolean {
  return /:\s*$/.test(text.trim());
}

/** Strips a leading list marker so "- Fees are X" is scored as "Fees are X". */
function stripListMarker(line: string): string {
  return line.replace(/^[ \t]*(?:\d+[.)]|[-*+])[ \t]+/, '');
}

/**
 * Splits a prose run into sentences.
 *
 * Requires a capital, quote or bracket after the boundary, so decimals survive:
 * "5.0" has "0" after the period and never splits. Abbreviations mid-sentence
 * ("Prof. Omoregie") would split wrongly, which is why list items are kept whole
 * rather than sentence-split — structured answers are where that would bite.
 */
function splitSentences(run: string): string[] {
  return run
    .split(/(?<=[.!?])\s+(?=["'(\[*]*[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Extracts citations and returns the prose with badges removed. */
function extractCitations(raw: string): { text: string; citations: Citation[] } {
  const citations: Citation[] = [];
  CITATION_RE.lastIndex = 0;
  for (const m of raw.matchAll(CITATION_RE)) {
    citations.push({ label: Number(m[1]), target: Number(m[2]) });
  }
  // Removing a badge leaves the gap it sat in — "Omoregie [1](cite:1)." becomes
  // "Omoregie ." — so whitespace is closed up both between words and before
  // punctuation. Not cosmetic: this text is what an EntailmentJudge receives,
  // and a stray " ." is noise in the claim it has to reason about.
  const text = raw
    .replace(CITATION_RE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?)\]])/g, '$1')
    .trim();
  return { text, citations };
}

/**
 * Segments an answer into citation-bearing statements.
 *
 * List items are one statement each and are NOT sentence-split: a numbered
 * procedure step is a single assertion carrying a single citation, and slicing
 * it would invent uncited fragments that were never separate claims.
 */
export function parseStatements(answer: string): Statement[] {
  const statements: Statement[] = [];
  let index = 0;

  for (const line of answer.split('\n')) {
    if (isStructural(line)) continue;

    const isListItem = /^[ \t]*(?:\d+[.)]|[-*+])[ \t]+/.test(line);
    const body = isListItem ? stripListMarker(line) : line;
    const runs = isListItem ? [body] : splitSentences(body);

    for (const run of runs) {
      const { text, citations } = extractCitations(run);
      if (text === '') continue;
      statements.push({
        text,
        citations,
        index: index++,
        expectsCitation: !isLabelOrStem(text),
      });
    }
  }

  return statements;
}

/**
 * Structural attribution metrics. Pure: no network, no model, no judgement
 * about meaning.
 *
 * `sources` is the tool's returned source list — only `number` is read, so
 * callers may pass the full Source objects.
 */
export function scoreAttribution(
  answer: string,
  sources: ReadonlyArray<{ number: number }>,
): AttributionReport {
  const statements = parseStatements(answer);
  const valid = new Set(sources.map((s) => s.number));

  const claims = statements.filter((s) => s.expectsCitation);
  const citedClaims = claims.filter((s) => s.citations.length > 0);

  const all = statements.flatMap((s) => s.citations);
  const dangling = all.filter((c) => !valid.has(c.target));
  const mismatched = all.filter((c) => c.label !== c.target);

  const cited = new Set(all.map((c) => c.target));
  const uncitedSources = sources
    .map((s) => s.number)
    .filter((n) => !cited.has(n))
    .sort((a, b) => a - b);

  return {
    statements,
    claimCount: claims.length,
    citedClaimCount: citedClaims.length,
    citationCoverage: claims.length === 0 ? 1 : citedClaims.length / claims.length,
    totalCitations: all.length,
    dangling,
    mismatched,
    uncitedSources,
    multiCited: statements.filter((s) => s.citations.length > 1).length,
  };
}

// ── Semantic tier — ALCE proper, pending a judge ──────────────────────────────

/**
 * Decides whether `passage` supports `claim`.
 *
 * Supply an NLI model (AlignScore, MiniCheck, an MNLI cross-encoder) or an
 * LLM judge. Do NOT supply a substring test: that is the failure this module's
 * header documents, and it would silently turn ALCE into string overlap.
 */
export type EntailmentJudge = (claim: string, passage: string) => Promise<boolean>;

export interface CitationSupport {
  /** Fraction of cited claims whose cited passages jointly support them. */
  citationRecall: number;
  /** Fraction of citations that contribute to their statement's support. */
  citationPrecision: number;
  /** Claims whose citations do not support them — the interesting failures. */
  unsupported: Statement[];
  /** How many claims were judged. Zero means the result is vacuous. */
  judged: number;
}

/**
 * ALCE-style citation recall and precision.
 *
 * recall:    a cited claim counts as supported when the CONCATENATION of its
 *            cited passages entails it.
 * precision: a citation counts as relevant when removing it breaks that
 *            support, or when it entails the claim on its own. A citation that
 *            neither contributes nor stands alone is padding — this is what
 *            catches the badge-stacking the format scorer only sees
 *            syntactically.
 *
 * Claims with no citations are excluded from BOTH: they are a coverage failure,
 * already reported as citationCoverage, and folding them in here would conflate
 * "cited the wrong thing" with "cited nothing".
 */
export async function scoreCitationSupport(
  report: AttributionReport,
  passages: ReadonlyMap<number, string>,
  judge: EntailmentJudge,
): Promise<CitationSupport> {
  const cited = report.statements.filter((s) => s.expectsCitation && s.citations.length > 0);

  const unsupported: Statement[] = [];
  let supportedClaims = 0;
  let relevantCitations = 0;
  let totalCitations = 0;

  for (const stmt of cited) {
    const targets = [...new Set(stmt.citations.map((c) => c.target))];
    const textOf = (ns: number[]) => ns.map((n) => passages.get(n) ?? '').join('\n\n');

    const supported = await judge(stmt.text, textOf(targets));
    if (supported) supportedClaims++;
    else unsupported.push(stmt);

    for (const n of targets) {
      totalCitations++;
      // Relevant if it stands alone, or if dropping it breaks joint support.
      const alone = await judge(stmt.text, textOf([n]));
      if (alone) { relevantCitations++; continue; }
      const rest = targets.filter((t) => t !== n);
      const withoutIt = rest.length > 0 ? await judge(stmt.text, textOf(rest)) : false;
      if (supported && !withoutIt) relevantCitations++;
    }
  }

  return {
    citationRecall:    cited.length === 0 ? 0 : supportedClaims / cited.length,
    citationPrecision: totalCitations === 0 ? 0 : relevantCitations / totalCitations,
    unsupported,
    judged: cited.length,
  };
}

/** One-line summary for a run report. */
export function formatAttribution(r: AttributionReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const parts = [
    `coverage ${pct(r.citationCoverage)} (${r.citedClaimCount}/${r.claimCount} claims cited)`,
    `${r.totalCitations} citation(s)`,
  ];
  if (r.dangling.length > 0)   parts.push(`${r.dangling.length} DANGLING [${r.dangling.map((c) => c.target).join(', ')}]`);
  if (r.mismatched.length > 0) parts.push(`${r.mismatched.length} MISMATCHED label/anchor`);
  if (r.uncitedSources.length > 0) parts.push(`${r.uncitedSources.length} source(s) never cited`);
  return parts.join(', ');
}
