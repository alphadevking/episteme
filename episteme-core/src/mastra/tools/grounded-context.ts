// episteme-core/src/mastra/tools/grounded-context.ts
/**
 * Builds the VERIFIED SOURCES block the model synthesizes its answer from.
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────────
 * It used to live inside grounded-response-tool.ts, which imports
 * knowledge-retrieval-tool, which constructs a Pinecone client AT MODULE SCOPE.
 * Importing it from a unit test therefore demanded live credentials, so the
 * most consequential prompt logic in the system had no test at all. Extracted
 * here it is pure — string in, string out — and imports the retrieval types with
 * `import type`, which the compiler erases, so nothing reaches the network.
 *
 * ── WHAT IS AT STAKE ─────────────────────────────────────────────────────────
 * This function attaches the date labels the conflict rule depends on. The rule
 * exists because of a real incident: the agent answered with a 2022 handbook's
 * former Vice Chancellor while a current principal-staff source sat next to it
 * in the same context. The instruction added in response tells the model to
 * state ONLY the value from the most recently dated source.
 *
 * That instruction can only work if the labels are correct. If a refactor drops
 * a date tag, mislabels a dated source as "undated", or silently stops emitting
 * the conflict paragraph, the model loses the ability to choose correctly and
 * NOTHING ELSE WOULD CATCH IT — the failure is a stale answer that reads
 * perfectly well. That is what the tests beside this file pin.
 *
 * The other half of the rule — whether the model OBEYS an instruction it was
 * correctly given — needs a live model and belongs in the prompt evals. This
 * module guarantees the input to that decision, not the decision.
 */
import { documentSource, type Source } from './source';
import type { KnowledgeRetrievalResponse } from './knowledge-retrieval-tool';

/**
 * Unified source shape across every tier — defined in ./source.ts so the
 * platform tier and the record tools cannot drift from it.
 */
type UnifiedSource = Source;

/** Human-readable document title derived from a source URL. */
export function deriveTitle(source: string): string {
  try {
    const url = new URL(source);
    const path = url.pathname.replace(/\.(html?|pdf|aspx?)$/i, '').replace(/\/$/, '');
    const segment = path.split('/').filter(Boolean).pop() ?? '';
    if (!segment) return url.hostname.replace(/^www\./, '');
    return segment
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return source;
  }
}

/**
 * Assembles numbered, date-labelled source blocks plus the synthesis rules.
 */
export function buildGroundedContext(
  retrieval: KnowledgeRetrievalResponse & { found: true },
): { context: string; sources: UnifiedSource[] } {
  // Deduplicate sources by URL so multiple chunks from the same document share
  // one citation number — but a document can still be cited via chunks from
  // several different pages, so pages accumulate across all of a source's chunks.
  const sourceIndex = new Map<string, { number: number; title: string; pages: Set<number> }>();
  let sourceCount = 0;
  for (const r of retrieval.results) {
    if (!sourceIndex.has(r.source)) {
      sourceCount++;
      sourceIndex.set(r.source, { number: sourceCount, title: deriveTitle(r.source), pages: new Set() });
    }
    if (r.pageNumber != null) sourceIndex.get(r.source)!.pages.add(r.pageNumber);
  }

  const anyStale   = retrieval.results.some((r) => r.staleWarning != null);
  const anyUndated = retrieval.results.some((r) => r.updatedAt == null);

  const lines: string[] = [
    'VERIFIED SOURCES — synthesize your answer exclusively from these chunks.',
    'Cite each fact inline as [N](cite:N) where N is the source number shown below (e.g. [1](cite:1)).',
    'The reader sees a numbered source list rendered below your answer automatically — do not add a',
    '## Sources section, do not restate the list, and do not paste any URL into your answer.',
    '',
    // Conflict rule — without this, two "verified" chunks that disagree on a
    // time-varying fact (office holders, fees, deadlines) leave the model free
    // to pick either; it was observed answering with a 2022 handbook's former
    // VC while a current principal-staff source sat right next to it.
    'Each source below is labelled with its content date, or as "undated". When sources',
    'DISAGREE on a fact that changes over time (who holds an office, fees, deadlines,',
    'calendars), state ONLY the value from the most recently dated source, and cite that',
    'source. Never present an older source\'s value as current — not even alongside the',
    'newer one. A DATED source beats an undated one on such a fact, whatever order they',
    'appear in below.',
  ];

  if (anyUndated) {
    lines.push(
      '',
      'A source marked "undated" carries no publication date — its age is unknown, which is',
      'not the same as being old. Use it normally, but when it supplies a fact that changes',
      'over time, tell the reader that source is undated and its currency could not be',
      'confirmed. Do not describe it as outdated, and do not guess when it was written.',
    );
  }

  if (anyStale) {
    lines.push(
      '',
      'A source marked "may be outdated" may only be used for facts no fresher source covers,',
      'and the answer must then tell the reader the information may be outdated and should be',
      'verified with the relevant office.',
    );
  }

  retrieval.results.forEach((r) => {
    const src = sourceIndex.get(r.source)!;
    // An undated source is labelled as such rather than given a fabricated or
    // omitted date: the model needs to know the difference between "published
    // in 2022" and "we don't know when this was written" to hedge correctly.
    const dateTag = r.updatedAt
      ? `dated ${new Date(r.updatedAt).toLocaleDateString('en-GB', {
          day: 'numeric', month: 'long', year: 'numeric',
        })}`
      : 'undated';
    const staleTag = r.staleWarning ? ' — may be outdated' : '';
    lines.push('');
    lines.push(`[Source ${src.number} — ${dateTag}${staleTag}] ${r.content}`);
  });

  const sources: UnifiedSource[] = Array.from(
    sourceIndex,
    ([url, { number, title, pages }]) =>
      documentSource({ number, title, url, pages: Array.from(pages).sort((a, b) => a - b) }),
  );

  return { context: lines.join('\n'), sources };
}
