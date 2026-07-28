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
  type PlatformSection,
} from '../ingestion/platform-docs';
import { PLATFORM_DOCS_CONFIG } from '../config';

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

export interface PlatformHit {
  /** Model-facing context, in the same VERIFIED SOURCES shape the KB tier uses. */
  context: string;
  sources: { number: number; title: string; url: string; pages: number[] }[];
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

  const ranked = rankSections(
    visible,
    query,
    PLATFORM_DOCS_CONFIG.minCoverage,
    PLATFORM_DOCS_CONFIG.strongCoverage,
  ).slice(0, PLATFORM_DOCS_CONFIG.maxResults);
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
    sources: Array.from(sourceIndex.values()).map(({ number, title }) => ({
      number,
      title,
      // Deliberately empty: these documents have no public URL, and the client
      // renders a non-link source entry for an empty href. Inventing a docs
      // site link that 404s would be worse than none.
      url: '',
      pages: [],
    })),
  };
}
