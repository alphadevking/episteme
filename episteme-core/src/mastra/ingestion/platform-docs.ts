// episteme-core/src/mastra/ingestion/platform-docs.ts
/**
 * Platform documentation corpus — the Markdown files ARE the corpus.
 *
 * These docs describe behaviour implemented in this repo, so the files on disk
 * are the single source of truth and are read directly at request time. They
 * are deliberately NOT ingested into Pinecone:
 *
 *   - A vector copy is a second source of truth. Keeping it aligned needs a
 *     lockfile, a hash diff, a CI guard and a deploy step, all of which exist
 *     only to manage drift that does not otherwise exist. If the deploy step
 *     silently fails, the failure surfaces to a user as "no verified
 *     information" — the worst possible symptom for a documentation gap.
 *   - The staleness model does not apply. It assumes a document describes a
 *     world that changes independently of the code ("this handbook is from 2022,
 *     verify with the relevant office"). Platform docs describe the code itself:
 *     there is no office to verify with, and a wrong platform doc is a bug to
 *     fix, not a caveat to display. Routing them through the KB path made a
 *     year-old doc divert to UNIBEN news and web search — see the cascade's
 *     topIsStale branch in grounded-response-tool.ts.
 *   - The corpus is small, self-authored and structured. Section-level lexical
 *     ranking over our own headings is sufficient and fully deterministic.
 *
 * Deliberately pure with respect to secrets and network: no Pinecone client, no
 * database, no embedding calls. Unit-testable without credentials, same
 * rationale as security/retrieval-gate.ts.
 *
 * If this corpus grows past roughly twenty documents, or starts fielding
 * questions whose wording shares few words with the headings, revisit embedding
 * it — that is the point at which lexical ranking degrades.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PLATFORM_HELP_NAMESPACE,
  PLATFORM_ADMIN_NAMESPACE,
} from '../security/retrieval-gate';

/**
 * Directory name → namespace. A file's LOCATION decides its namespace; the
 * frontmatter must agree. Trusting the frontmatter alone would let a typo
 * publish an operator runbook into the namespace every user can read.
 */
export const DIRECTORY_NAMESPACE: Record<string, string> = {
  help:  PLATFORM_HELP_NAMESPACE,
  admin: PLATFORM_ADMIN_NAMESPACE,
};

/** Mirrors kb-routes' VALID_ROLES — the retrieval role space. */
const VALID_ROLES = new Set(['prospective', 'student', 'parent', 'staff', 'hod']);

export interface PlatformDoc {
  docId: string;
  title: string;
  namespace: string;
  roles: string[];
  /** ISO string — the content's own editorial date. Drives staleness. */
  updated: string;
  /**
   * Vocabulary this document answers to but does not itself use.
   *
   * The ranker is purely lexical: a query term must literally appear in the
   * text. That is fine for a corpus we author, EXCEPT that readers do not know
   * our wording. "What are your capabilities" scored zero against a help page
   * that explains capabilities at length but never writes the word — so the
   * assistant abstained on a question about itself.
   *
   * Keywords close that gap without embeddings: they are the author stating
   * "this page answers to these words too". Treated exactly like heading terms,
   * because that is what they are — a claim about what the page is ABOUT.
   *
   * Optional; a document that omits them behaves as before.
   */
  keywords: string[];
  body: string;
  /** Path relative to the content root, e.g. "admin/institution-setup.md". */
  relPath: string;
}

// ── Frontmatter ───────────────────────────────────────────────────────────────

/**
 * Minimal YAML frontmatter reader — scalars and inline `[a, b]` lists only.
 *
 * Deliberately not a YAML dependency: the schema is small and fixed, and an
 * unexpected construct should fail loudly rather than be silently coerced into
 * a security-relevant field like `roles`.
 */
export function parseFrontmatter(
  raw: string,
  relPath: string,
): { data: Record<string, string | string[]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) throw new Error(`${relPath}: missing frontmatter block`);

  const data: Record<string, string | string[]> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) throw new Error(`${relPath}: malformed frontmatter line: ${line}`);

    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();

    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      data[key] = value.replace(/^["']|["']$/g, '');
    }
  }

  return { data, body: raw.slice(match[0].length) };
}

function requireString(
  data: Record<string, string | string[]>,
  key: string,
  relPath: string,
): string {
  const v = data[key];
  if (typeof v !== 'string' || !v) throw new Error(`${relPath}: frontmatter "${key}" is required`);
  return v;
}

/**
 * Parse and fully validate one document. Throws on anything malformed — there
 * is no "best effort" mode, because a doc that silently fails to validate is a
 * doc that silently is not in the knowledge base.
 *
 * @param dir The directory the file was found in — authoritative for namespace.
 * @param now Injectable clock, so the future-date check is testable.
 */
export function parsePlatformDoc(
  raw: string,
  dir: string,
  fileName: string,
  now: number = Date.now(),
): PlatformDoc {
  const relPath = `${dir}/${fileName}`;
  const { data, body } = parseFrontmatter(raw, relPath);

  const expected = DIRECTORY_NAMESPACE[dir];
  if (!expected) throw new Error(`${relPath}: unknown content directory "${dir}"`);

  const namespace = requireString(data, 'namespace', relPath);
  if (namespace !== expected) {
    throw new Error(
      `${relPath}: namespace "${namespace}" does not match directory "${dir}" (expected "${expected}")`,
    );
  }

  const roles = data['roles'];
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error(`${relPath}: frontmatter "roles" must be a non-empty list`);
  }
  const invalid = roles.filter((r) => !VALID_ROLES.has(r));
  if (invalid.length > 0) throw new Error(`${relPath}: invalid roles: ${invalid.join(', ')}`);

  const updatedRaw = requireString(data, 'updated', relPath);
  const updatedDate = new Date(updatedRaw);
  if (isNaN(updatedDate.getTime())) {
    throw new Error(`${relPath}: "updated" is not a valid date: ${updatedRaw}`);
  }
  // One day of slack for timezone skew between author and CI runner.
  if (updatedDate.getTime() > now + 86_400_000) {
    throw new Error(`${relPath}: "updated" is in the future: ${updatedRaw}`);
  }

  // Optional, but must be a list of non-empty strings when present — a typo'd
  // scalar would otherwise be silently ignored and the alias never applied.
  const rawKeywords = data['keywords'];
  if (rawKeywords !== undefined && !Array.isArray(rawKeywords)) {
    throw new Error(`${relPath}: frontmatter "keywords" must be a list`);
  }
  const keywords = ((rawKeywords as unknown[]) ?? []).map((k) => {
    if (typeof k !== 'string' || !k.trim()) {
      throw new Error(`${relPath}: "keywords" entries must be non-empty strings`);
    }
    return k.trim();
  });

  if (!body.trim()) throw new Error(`${relPath}: document body is empty`);

  return {
    docId:   requireString(data, 'docId', relPath),
    title:   requireString(data, 'title', relPath),
    namespace,
    roles,
    updated: updatedDate.toISOString(),
    keywords,
    body,
    relPath,
  };
}

/** Reject duplicate docIds — ingestion deletes by docId, so two files sharing
 *  one would silently overwrite each other and only the last would survive. */
export function assertUniqueDocIds(docs: PlatformDoc[]): void {
  const seen = new Map<string, string>();
  for (const doc of docs) {
    const prior = seen.get(doc.docId);
    if (prior) {
      throw new Error(`duplicate docId "${doc.docId}" in ${prior} and ${doc.relPath}`);
    }
    seen.set(doc.docId, doc.relPath);
  }
}

/** Read and validate the whole corpus from disk. */
export async function loadPlatformDocs(contentRoot: string): Promise<PlatformDoc[]> {
  const docs: PlatformDoc[] = [];

  for (const dir of Object.keys(DIRECTORY_NAMESPACE)) {
    let entries: string[];
    try {
      entries = await readdir(join(contentRoot, dir));
    } catch {
      continue; // directory not created yet
    }
    for (const fileName of entries.filter((f) => f.endsWith('.md')).sort()) {
      const raw = await readFile(join(contentRoot, dir, fileName), 'utf8');
      docs.push(parsePlatformDoc(raw, dir, fileName));
    }
  }

  // An EMPTY corpus is a broken deployment, never a valid state.
  //
  // The per-directory `continue` above tolerates a missing help/ or admin/
  // folder, which is right while the repo is being set up. But finding NOTHING
  // anywhere means the Markdown never reached this machine — exactly what
  // happened on Vercel, where the build bundles JS and copies no content. It
  // failed silently: zero documents, no error, and a platform tier that
  // abstained on every question about the product itself while every local
  // test passed. Throw so the caller can say so out loud.
  if (docs.length === 0) {
    throw new Error(
      `no platform documents found under ${contentRoot} — ` +
      'the corpus is missing from this deployment (the build must copy src/content)',
    );
  }

  assertUniqueDocIds(docs);
  return docs;
}

// ── Sectioning ────────────────────────────────────────────────────────────────

/**
 * A retrievable unit: one `##` section of one document.
 *
 * Sections rather than whole documents, for the same reason the KB pipeline
 * chunks: returning an entire 800-word document to answer one question buries
 * the answer and wastes context. Our own headings are the natural boundary, so
 * no heuristic splitter is needed.
 */
export interface PlatformSection {
  docId: string;
  /** Document title, from frontmatter. Used as the citation title. */
  title: string;
  /** The `##` heading this section sits under, or the doc title for the intro. */
  heading: string;
  /** Heading + prose, ready to hand to the model. */
  text: string;
  /**
   * Document-level `keywords` from frontmatter, carried onto every section.
   *
   * Ranked as heading terms (see rankSections), NOT as body text: they are the
   * author's statement of what the document answers to, which is precisely what
   * a heading is. They are deliberately kept OUT of `text` so they never reach
   * the model — a keyword is a retrieval alias, not content to cite.
   */
  keywords: string[];
  namespace: string;
  roles: string[];
  relPath: string;
}

/**
 * Split a document into `##` sections. Content before the first `##` (including
 * the `#` title line) becomes an intro section headed by the document title.
 *
 * Fenced code blocks are respected — a `##` inside ``` is a comment, not a
 * heading, and splitting on it would tear a code block in half.
 */
export function splitIntoSections(doc: PlatformDoc): PlatformSection[] {
  const lines = doc.body.split(/\r?\n/);
  const sections: PlatformSection[] = [];

  let heading = doc.title;
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = buffer.join('\n').trim();
    // A heading with no prose under it (e.g. `##` immediately followed by
    // another `##`) carries no answer, so it is not retrievable on its own.
    if (text) {
      sections.push({
        docId: doc.docId,
        keywords: doc.keywords,
        title: doc.title,
        heading,
        text: `${heading}\n\n${text}`,
        namespace: doc.namespace,
        roles: doc.roles,
        relPath: doc.relPath,
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;

    const match = !inFence ? /^##\s+(.*\S)\s*$/.exec(line) : null;
    if (match) {
      flush();
      heading = match[1];
      continue;
    }
    // Drop the `# Title` line: the frontmatter title already carries it, and
    // leaving it in the intro section duplicates the term in every score.
    if (!inFence && /^#\s+/.test(line)) continue;

    buffer.push(line);
  }
  flush();

  return sections;
}

// ── Ranking ───────────────────────────────────────────────────────────────────

/**
 * Function words plus terms so common across this corpus that matching on them
 * says nothing about relevance. IDF below already discounts corpus-common
 * terms; this list removes the ones that would otherwise survive a short query.
 */
const PLATFORM_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those',
  'are', 'was', 'were', 'can', 'will', 'would', 'should', 'does', 'did',
  'how', 'what', 'why', 'when', 'where', 'which', 'who', 'whom',
  'you', 'your', 'our', 'their', 'its', 'his', 'her', 'them', 'they',
  'into', 'onto', 'about', 'than', 'then', 'there', 'here',
  'have', 'has', 'had', 'get', 'got', 'set', 'put', 'use', 'used', 'using',
  'not', 'but', 'all', 'any', 'each', 'more', 'most', 'other', 'some',
  'episteme', 'platform', 'system', 'assistant',
]);

/** Content tokens of a string: alphanumeric runs, length>2, stopwords removed. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length > 2 && !PLATFORM_STOPWORDS.has(t));
}

/** Crude but stable suffix stripping, so "onboarding" matches "onboard" and
 *  "levels" matches "level". Deliberately conservative — over-stemming
 *  ("access" → "acces") creates false matches that are harder to debug. */
function stem(token: string): string {
  for (const suffix of ['ing', 'ies', 'es', 's']) {
    if (token.length > suffix.length + 3 && token.endsWith(suffix)) {
      return suffix === 'ies' ? `${token.slice(0, -3)}y` : token.slice(0, -suffix.length);
    }
  }
  return token;
}

const stemAll = (tokens: string[]): string[] => tokens.map(stem);

export interface RankedSection {
  section: PlatformSection;
  /** BM25 relevance — unbounded, comparable only within one query. */
  score: number;
  /** Fraction (0–1) of the query's distinct content terms present anywhere. */
  coverage: number;
  /** How many distinct query terms appear in the section's own heading. */
  headingMatches: number;
}

/** BM25 parameters — standard defaults; the corpus is too small to tune against. */
const K1 = 1.2;
const B  = 0.75;
/** A term in a heading counts this many times toward term frequency. Headings
 *  are the author's own statement of what a section answers. */
const HEADING_WEIGHT = 3;

/**
 * Rank sections against a query.
 *
 * Three signals, because they answer different questions:
 *
 *   coverage       — "does this section address the query at all?" Bounded 0–1,
 *                    so it means something regardless of query length. BM25
 *                    alone would need a magic unbounded threshold.
 *   headingMatches — "is the section ABOUT this, or does it merely mention it?"
 *   BM25           — "which of the addressing sections is best?" Ordering only.
 *
 * The heading signal exists because coverage alone produced a real false
 * positive: these docs explain platform concepts using university examples
 * ("a fees document placed in General is readable by every visitor"), so a
 * genuine question about school fees matched incidental mentions of *fees*,
 * *level* and *students* and hit the coverage gate exactly. Capturing an
 * institutional question here is the worst possible failure — the cascade never
 * reaches the knowledge base and the user gets documentation instead of policy.
 *
 * A section therefore qualifies only if EITHER:
 *   - at least one query term appears in its own heading (the author's
 *     statement of what the section answers), and coverage clears the gate; OR
 *   - coverage is very high (strongCoverage), which covers a legitimate query
 *     whose wording matches the prose rather than the heading.
 *
 * Raising minCoverage instead would have moved the boundary, not fixed the
 * confusion — an incidental mention is not weak evidence of aboutness, it is
 * the wrong kind of evidence.
 */
export function rankSections(
  sections: PlatformSection[],
  query: string,
  minCoverage: number,
  strongCoverage = 0.75,
): RankedSection[] {
  const queryTerms = Array.from(new Set(stemAll(tokenize(query))));
  if (queryTerms.length === 0 || sections.length === 0) return [];

  // Frontmatter keywords join the HEADING term space, not the body: both are
  // the author asserting what this section is about, and both should therefore
  // satisfy the "is it about this, or does it merely mention it?" gate. Folding
  // them into the body instead would let an alias sneak a section past coverage
  // without ever making it the section's subject.
  const docTerms = sections.map((s) => ({
    body:    stemAll(tokenize(s.text)),
    heading: stemAll(tokenize([s.heading, ...s.keywords].join(' '))),
  }));

  const lengths = docTerms.map((d) => d.body.length + d.heading.length * HEADING_WEIGHT);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;

  // Document frequency per query term, over sections.
  const df = new Map<string, number>();
  for (const term of queryTerms) {
    df.set(term, docTerms.filter((d) => d.body.includes(term) || d.heading.includes(term)).length);
  }

  const N = sections.length;
  const ranked: RankedSection[] = sections.map((section, i) => {
    const { body, heading } = docTerms[i];
    let score = 0;
    let matched = 0;
    let headingMatches = 0;

    for (const term of queryTerms) {
      const inHeading = heading.filter((t) => t === term).length;
      const freq = body.filter((t) => t === term).length + inHeading * HEADING_WEIGHT;
      if (freq === 0) continue;
      matched++;
      if (inHeading > 0) headingMatches++;

      // Standard BM25 IDF. The +1 keeps it positive for a term appearing in
      // every section, which would otherwise score negative and push a fully
      // matching section below a partial one.
      const idf = Math.log(1 + (N - df.get(term)! + 0.5) / (df.get(term)! + 0.5));
      score += idf * (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * (lengths[i] / avgLength)));
    }

    return { section, score, coverage: matched / queryTerms.length, headingMatches };
  });

  return ranked
    .filter((r) =>
      r.score > 0 &&
      r.coverage >= minCoverage &&
      (r.headingMatches > 0 || r.coverage >= strongCoverage))
    .sort((a, b) => b.score - a.score);
}
