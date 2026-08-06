// tools/corpus-manifest.ts
//
// WHAT THIS CALLER CAN ACTUALLY BE OFFERED, read from the live corpus.
//
// THE PROBLEM IT SOLVES
//
// When retrieval finds nothing, the agent is asked to offer the user 2–3 other
// angles to try. It was doing that blind: the abstention payload told it "no
// verified information was found" and, in the same breath, "you have not been
// shown what the knowledge base contains" — so every alternative it proposed was
// a guess. The prompt's own worked example offered a fee schedule, payment steps
// and accommodation charges; the first two have no source in this corpus at all,
// so a user who picked one was refused a second time. A dead-end loop reads as a
// broken assistant rather than a thin corpus.
//
// The same gap produced the other invention: "contact the relevant office" was
// returned as a bare instruction with no office list ever supplied, so the model
// named one from memory — possibly with an invented address. That is the exact
// failure class the agent prompt forbids everywhere else (never invent course
// codes, copy names letter-for-letter); it was being *required* here.
//
// THE FIX, AND WHY IT IS DERIVED RATHER THAN CURATED
//
// A hand-maintained list of "topics we can answer" would be wrong the first time
// a document is ingested or removed, and nothing would catch it. So this reads
// the corpus instead: the distinct documents reachable BY THIS CALLER, through
// the same namespace resolution and the same metadata filter that retrieval
// itself uses. What it returns is therefore true by construction, stays true as
// the corpus changes, and cannot name a document the caller may not see.
//
// SECURITY: this is a retrieval, not an inspection. It goes through
// resolveNamespacesForRoles + buildRetrievalFilter unchanged, so it is bounded
// by exactly the same role/trust/institution/allowlist envelope as a normal
// query. It reveals only that a document EXISTS and is readable — never content.
//
// COST: one cached embedding, then one Pinecone query per reachable namespace,
// and only on the abstention path — the branch that would otherwise return
// nothing at all. Results are cached per access-envelope; see CACHE_TTL_MS.

import { Pinecone } from '@pinecone-database/pinecone';
import { resolveNamespacesForRoles, buildRetrievalFilter } from '../security/retrieval-gate';

/** A document this caller is entitled to read. */
export type ReachableSource = {
  /** The `source` metadata exactly as ingested — a URL or filename. */
  source: string;
  /** Mechanically derived readable form of `source`. Never a coined title. */
  label: string;
  namespace: string;
};

export type ManifestInput = {
  roles: string[];
  trustLevel?: number;
  institutionId?: string;
  namespaceAllowlist?: string[];
};

/**
 * How long a caller's reachable-document list stays cached.
 *
 * Short enough that a newly ingested document shows up in the same working
 * session, long enough that a run of abstentions doesn't re-probe every
 * namespace each time. Ingestion is a deliberate, infrequent act; this does not
 * need to be live to the second.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * How many chunks to sample per namespace when discovering documents.
 *
 * This is a document-discovery sample, not a search: it only needs to surface
 * the DISTINCT `source` values present, and chunks from the same document are
 * heavily redundant. A namespace holding more documents than this sample can
 * reveal will under-report — which is the safe direction, since every entry
 * returned is still genuinely reachable. Over-reporting would be the defect.
 */
const PROBE_TOP_K = 60;

/**
 * A deliberately generic probe. It is NOT a query — nothing about the user's
 * question belongs here — it exists only to give Pinecone a vector so the
 * metadata filter can do the actual work. Ordering of the results is irrelevant
 * because everything returned is deduped to a document set.
 */
const PROBE_TEXT = 'university information';

let probeVector: Promise<number[]> | null = null;

/**
 * Embedded once per process — the probe text never varies.
 *
 * The embedder is imported DYNAMICALLY: it constructs a Mistral client at module
 * scope and throws without MISTRAL_API_KEY, so a static import would make this
 * module unloadable on a machine with no credentials — including the test
 * runner, which would leave the abstention text (the most-seen text in the
 * product for this corpus) with nothing asserting against it.
 */
function getProbeVector(): Promise<number[]> {
  if (!probeVector) {
    probeVector = import('../ingestion/embedder')
      .then(({ embedTexts }) => embedTexts([PROBE_TEXT]))
      .then((vecs) => {
        const vec = vecs[0];
        if (!vec) throw new Error('probe embedding returned no vector');
        return vec;
      })
      // A failed embedding must not be cached as a permanently rejected promise,
      // or every later abstention in this process inherits one transient error.
      .catch((err) => { probeVector = null; throw err; });
  }
  return probeVector;
}

const cache = new Map<string, { at: number; value: ReachableSource[] }>();

/**
 * Cache key = the full access envelope. Two callers share an entry only when
 * they would see exactly the same documents, so the cache can never widen what
 * someone is shown. Roles are sorted because the union's order is incidental.
 */
function cacheKey(input: ManifestInput): string {
  return JSON.stringify({
    roles: [...input.roles].sort(),
    trust: input.trustLevel ?? 1,
    inst:  input.institutionId ?? null,
    allow: input.namespaceAllowlist ? [...input.namespaceAllowlist].sort() : null,
  });
}

/**
 * Readable form of a source identifier.
 *
 * Strictly mechanical — strips the URL scheme/host, the directory path and the
 * file extension, then turns separators into spaces. It never coins a title:
 * "STUDENTHANDBOOK.pdf" becomes "STUDENTHANDBOOK", not "Student Handbook",
 * because expanding it would be a guess about what the document is called, and
 * guessing names is the failure this module exists to remove. The raw `source`
 * travels alongside it so nothing is lost.
 */
export function labelForSource(source: string): string {
  const withoutQuery = source.split(/[?#]/)[0] ?? source;
  const lastSegment  = withoutQuery.split('/').filter(Boolean).pop() ?? withoutQuery;
  const withoutExt   = lastSegment.replace(/\.(pdf|html?|docx?|txt|md)$/i, '');
  const spaced       = withoutExt.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced || source;
}

/**
 * The documents this caller can read, deduped by source.
 *
 * FAILS SOFT AND EMPTY. Every error path returns `[]` rather than throwing:
 * this runs on the abstention branch, where the alternative to "no options" is
 * a 500 on a request that was already going to disappoint the user. An empty
 * result is also the honest input to the prompt — it means "offer nothing",
 * which is precisely what the caller should say when it knows of nothing.
 */
export async function listReachableSources(
  input: ManifestInput,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<ReachableSource[]> {
  const key = cacheKey(input);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const apiKey    = process.env['PINECONE_API_KEY'];
  const indexName = process.env['PINECONE_INDEX'];
  if (!apiKey || !indexName) return [];

  const namespaces = resolveNamespacesForRoles({
    roles:              input.roles,
    trustLevel:         input.trustLevel,
    ...(input.namespaceAllowlist ? { namespaceAllowlist: input.namespaceAllowlist } : {}),
  });
  if (namespaces.length === 0) return [];

  try {
    const index  = new Pinecone({ apiKey }).index({ name: indexName });
    const vector = await getProbeVector();
    const filter = buildRetrievalFilter({
      role: input.roles,
      ...(input.institutionId ? { institutionId: input.institutionId } : {}),
    });

    const bySource = new Map<string, ReachableSource>();

    const perNamespace = await Promise.all(
      namespaces.map(async (ns) => {
        try {
          const res = await index.namespace(ns).query({
            vector, topK: PROBE_TOP_K, includeMetadata: true, filter,
          });
          return { ns, matches: res.matches ?? [] };
        } catch (err) {
          // One unreachable namespace must not cost the caller the others.
          logger?.warn('[corpusManifest] namespace probe failed', {
            namespace: ns, error: (err as Error).message,
          });
          return { ns, matches: [] };
        }
      }),
    );

    for (const { ns, matches } of perNamespace) {
      for (const match of matches) {
        const source = (match.metadata ?? {})['source'];
        if (typeof source !== 'string' || !source) continue;
        if (bySource.has(source)) continue;
        bySource.set(source, { source, label: labelForSource(source), namespace: ns });
      }
    }

    const value = [...bySource.values()];
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    logger?.warn('[corpusManifest] probe failed', { error: (err as Error).message });
    return [];
  }
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function __clearManifestCache(): void {
  cache.clear();
  probeVector = null;
}
