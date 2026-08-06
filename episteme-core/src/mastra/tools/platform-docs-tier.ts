// episteme-core/src/mastra/tools/platform-docs-tier.ts
/**
 * Platform documentation retrieval — the tier that answers questions about
 * Episteme itself, served directly from the Markdown files in
 * src/content/platform.
 *
 * No Pinecone, no embeddings, no ingestion step: the files are the corpus. See
 * the header of ingestion/platform-docs.ts for why a vector copy was rejected.
 *
 * The corpus is loaded once per process and cached. It ships with the code, so
 * it cannot change without a redeploy — re-reading disk per request would buy
 * nothing. A malformed corpus fails loudly at load and then degrades to "no
 * platform docs" rather than taking the whole chat path down with it.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPlatformDocs,
  splitIntoSections,
  rankSections,
  tokenize,
  type PlatformSection,
} from '../ingestion/platform-docs';
import { PLATFORM_DOCS_CONFIG } from '../config';
import { PLATFORM_HELP_NAMESPACE } from '../security/retrieval-gate';
import { documentSource, type Source } from './source';

const CONTENT_ROOT = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'content', 'platform',
);

let cache: Promise<PlatformSection[]> | null = null;

/** Load and section the corpus once per process. */
export function loadPlatformSections(
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<PlatformSection[]> {
  cache ??= loadPlatformDocs(CONTENT_ROOT)
    .then((docs) => docs.flatMap(splitIntoSections))
    .catch((err) => {
      // Fail soft: a broken corpus must not break institutional retrieval. The
      // corpus is validated in CI by platform-docs.test.ts, so reaching here
      // means something is wrong with the deployment itself.
      logger?.warn('[platformDocs] failed to load corpus', { error: (err as Error).message });
      return [];
    });
  return cache;
}

/** Test seam — drops the cached corpus. */
export function resetPlatformSectionCache(): void {
  cache = null;
}

/**
 * The query used when the user's own question carries no content terms.
 *
 * WHY THIS EXISTS. `tokenize` strips function words and the product's own names
 * — `episteme`, `platform`, `system`, `assistant` — because as discriminators
 * they are worthless: they appear in every document in this corpus. That is
 * correct for ranking, but it has a consequence nobody intended. "What can this
 * assistant do" tokenizes to NOTHING, rankSections early-returns on an empty
 * term set, and the single most natural phrasing of the one question every role
 * is guaranteed to be able to ask became unanswerable. The eval caught it as a
 * cascade case resolving to tier=none.
 *
 * A query that survives stopword removal with nothing left is not a vague query
 * — it is a precisely identifiable one. Every word in it was either grammar or
 * this product's name, which makes it a question about the product itself. So
 * the fallback is not a guess at intent; it is the only intent such a query can
 * have.
 *
 * The terms are chosen to match the help document's own headings ("What it can
 * answer", "Getting better answers"), and are kept FEW on purpose: `coverage` is
 * the fraction of query terms present in a section, so every term that fails to
 * appear drags a genuine match below the gate. Adding a plausible-sounding word
 * here that the docs do not use would silently break this path.
 */
const IDENTITY_QUERY = 'what it can answer, and how to ask a better question';

/**
 * True when a query is asking what this product is or does.
 *
 * Requires a non-empty query: an empty string also tokenizes to nothing, but it
 * is a caller bug rather than a question, and answering it with documentation
 * would hide that.
 */
function isIdentityQuestion(query: string): boolean {
  return query.trim().length > 0 && tokenize(query).length === 0;
}

export interface PlatformHit {
  /** Model-facing context, in the same VERIFIED SOURCES shape the KB tier uses. */
  context: string;
  sources: Source[];
}

/**
 * Search the platform corpus within the namespaces this session may read.
 *
 * `allowedNamespaces` comes from resolvePlatformNamespaces — the access gate.
 * Filtering happens BEFORE ranking so a platform-admin section can never place
 * in the results of a caller not entitled to it, regardless of score.
 *
 * Returns null when nothing clears the coverage gate, so the caller can fall
 * through to the next tier exactly as it does for a KB miss.
 */
export async function searchPlatformDocs(
  query: string,
  allowedNamespaces: string[],
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<PlatformHit | null> {
  const allowed = new Set(allowedNamespaces);
  if (allowed.size === 0) return null;

  const sections = await loadPlatformSections(logger);
  const visible = sections.filter((s) => allowed.has(s.namespace));
  if (visible.length === 0) return null;

  // A product-identity question ("what can this assistant do") is answered from
  // the HELP namespace only, and never from the admin runbooks — an operator
  // asking what the product does wants the same introduction everyone else
  // gets, not the ingestion procedure. Narrowing here also means this path can
  // never widen what a caller sees: `visible` is already access-filtered, and
  // this only ever removes from it.
  const identity = isIdentityQuestion(query);
  const searchSpace = identity
    ? visible.filter((s) => s.namespace === PLATFORM_HELP_NAMESPACE)
    : visible;
  if (searchSpace.length === 0) return null;

  const ranked = rankSections(
    searchSpace,
    identity ? IDENTITY_QUERY : query,
    PLATFORM_DOCS_CONFIG.minCoverage,
    PLATFORM_DOCS_CONFIG.strongCoverage,
  ).slice(0, PLATFORM_DOCS_CONFIG.maxResults);
  // Still fails closed: if the help document is rewritten such that IDENTITY_QUERY
  // no longer matches it, this returns null and the cascade continues, exactly as
  // it did before this fallback existed. The regression shows up as a failing
  // eval case, not as a wrong answer.
  if (ranked.length === 0) return null;

  // One citation per DOCUMENT, not per section: two sections of the same page
  // are one source to the reader, matching how the KB tier dedupes by URL.
  const sourceIndex = new Map<string, { number: number; title: string }>();
  for (const { section } of ranked) {
    if (!sourceIndex.has(section.docId)) {
      sourceIndex.set(section.docId, { number: sourceIndex.size + 1, title: section.title });
    }
  }

  const lines: string[] = [
    'VERIFIED SOURCES — product documentation for Episteme itself.',
    'Synthesize your answer exclusively from these chunks.',
    'Cite each fact inline as [N](cite:N) where N is the source number shown below (e.g. [1](cite:1)).',
    'The reader sees a numbered source list rendered below your answer automatically — do not add a',
    '## Sources section, do not restate the list, and do not paste any URL into your answer.',
    '',
    // Without this the model tends to answer a platform question with what it
    // knows about comparable software, which is exactly the failure the whole
    // grounding design exists to prevent.
    'These describe THIS product. Do not supplement them with how similar systems usually work —',
    'if a step is not stated below, say it is not documented rather than inferring it.',
    '',
    'This is product documentation, not institutional policy. Do not tell the reader to verify it',
    'with a university office, and do not describe it as possibly outdated.',
  ];

  for (const { section } of ranked) {
    lines.push('', `[Source ${sourceIndex.get(section.docId)!.number}] ${section.text}`);
  }

  return {
    context: lines.join('\n'),
    // No `url`: these ship in the repo and have no public address, so the
    // client renders them as plain text rather than a dead link. Inventing a
    // docs-site URL that 404s would be worse than none.
    sources: Array.from(sourceIndex.values()).map(({ number, title }) =>
      documentSource({ number, title, label: 'Episteme product documentation' }),
    ),
  };
}
