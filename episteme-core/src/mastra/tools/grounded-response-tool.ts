import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  retrieveKnowledge,
  type KnowledgeRetrievalResponse,
} from './knowledge-retrieval-tool';
import { fetchNewsPosts, buildNewsContext, type NewsResult } from './uniben-news-tool';
import { searchWeb, buildWebContext } from './web-search-tool';
import { RETRIEVAL_CONFIG, UNIBEN_NEWS_CONFIG } from '../config';
import { getSessionContext } from '../server/session-context';
import { searchPlatformDocs } from './platform-docs-tier';
import { resolvePlatformNamespaces } from '../security/retrieval-gate';

// ── Query rewriting ───────────────────────────────────────────────────────────
// Prepends available session context to the user's query before embedding.
// This anchors vague queries ("my courses", "my department") to the user's
// actual academic context, dramatically improving retrieval precision.
// No extra LLM call — pure string expansion, zero cost.
function rewriteQuery(
  query: string,
  ctx: {
    programme?: string;
    level?: string;
    department?: string;
    related_topics?: string[];
  },
): string {
  const parts: string[] = [];
  if (ctx.level && ctx.programme) parts.push(`${ctx.level} ${ctx.programme}`);
  else if (ctx.programme) parts.push(ctx.programme);
  else if (ctx.level) parts.push(`${ctx.level} level`);
  if (ctx.department) parts.push(ctx.department);

  // Append up to 2 recent session topics to boost semantic similarity
  // for follow-up questions (e.g. "what about the deadline?" → knows it means registration deadline)
  if (ctx.related_topics && ctx.related_topics.length > 0) {
    parts.push(ctx.related_topics.slice(0, 2).join(', '));
  }

  if (parts.length === 0) return query;
  return `${parts.join(' ')}: ${query}`;
}

// ── Answer builders ───────────────────────────────────────────────────────────

function deriveTitle(source: string): string {
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
 * Unified source shape across all three tiers this tool can resolve from.
 * `pages` is only ever populated for tier "kb" (paginated documents);
 * `published` is only ever populated for tier "news".
 */
type UnifiedSource = { number: number; title: string; url: string; pages: number[]; published?: string };

/**
 * Builds the model-facing context and the client-facing source list from the
 * same dedup pass, so the two can never drift apart the way a model-copied
 * "## Sources" markdown list could.
 *
 * The source list is NOT included in the text handed to the model — see
 * `toModelOutput` below. Asking the model to transcribe a source list into
 * markdown was measured to be unreliable (the same failure mode that led
 * unibenNewsTool to withhold post URLs from the model entirely); the client
 * renders `sources` directly instead, which cannot be garbled in transit.
 */
function buildGroundedContext(
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

  const anyStale = retrieval.results.some((r) => r.staleWarning != null);

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
    'Each source below is labelled with its content date. When sources DISAGREE on a fact',
    'that changes over time (who holds an office, fees, deadlines, calendars), state ONLY',
    'the value from the most recently dated source, and cite that source. Never present an',
    'older source\'s value as current — not even alongside the newer one.',
  ];

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
    const dated = new Date(r.updatedAt).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    const staleTag = r.staleWarning ? ' — may be outdated' : '';
    lines.push('');
    lines.push(`[Source ${src.number} — dated ${dated}${staleTag}] ${r.content}`);
  });

  const sources: UnifiedSource[] = Array.from(
    sourceIndex,
    ([url, { number, title, pages }]) => ({
      number,
      title,
      url,
      pages: Array.from(pages).sort((a, b) => a - b),
    }),
  );

  return { context: lines.join('\n'), sources };
}

function buildAbstentionAnswer(query: string): string {
  return `NO_RESULTS: The knowledge base does not contain verified information matching this query ("${query}"). Use this signal to acknowledge the gap and offer the user 2–3 concrete retrieval refinements based on their context and what was asked.`;
}

type CascadeHit = { answer: string; tier: 'news' | 'web'; sources: UnifiedSource[] };

/** Tier 2 — live news. Raw query, not the KB-enriched one: news search matches
 *  on article titles/summaries, and the programme/level prefix that helps
 *  embedding retrieval only dilutes a keyword match here.
 *
 *  Relevance-gated (fallbackMinScore): as a fallback ANSWER, an off-topic feed
 *  must not pose as a result — otherwise a query the news can't answer (JAMB
 *  cut-off, etc.) returns unrelated posts and the model abstains on data we
 *  actually hold. A null here lets the cascade fall through to web, or back to
 *  a relevant-but-stale KB match, instead. */
async function tryNewsFallback(
  query: string,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<CascadeHit | null> {
  let newsPosts: NewsResult[] = [];
  try {
    newsPosts = await fetchNewsPosts(query, UNIBEN_NEWS_CONFIG.fallbackMinScore);
  } catch (err) {
    logger?.warn('[groundedResponseTool] news fallback failed', { error: (err as Error).message });
  }
  if (newsPosts.length === 0) return null;

  const sources: UnifiedSource[] = newsPosts.map((p, i) => ({
    number: i + 1, title: p.title, url: p.url, pages: [], published: p.published,
  }));
  return { answer: buildNewsContext(newsPosts), tier: 'news', sources };
}

/** Tier 3 — web search, last resort. */
async function tryWebFallback(
  query: string,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<CascadeHit | null> {
  let webFound: { title: string; url: string; content: string; score: number }[] = [];
  try {
    const webResponse = await searchWeb(query);
    if (webResponse.found) webFound = webResponse.results;
  } catch (err) {
    logger?.warn('[groundedResponseTool] web fallback failed', { error: (err as Error).message });
  }
  if (webFound.length === 0) return null;

  const sources: UnifiedSource[] = webFound.map((r, i) => ({
    number: i + 1, title: r.title, url: r.url, pages: [],
  }));
  return { answer: buildWebContext(webFound), tier: 'web', sources };
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const groundedResponseTool = createTool({
  id: 'groundedResponseTool',
  description:
    'Retrieves a verified answer for any Uniben question, and for any question about the Episteme ' +
    'platform itself — how to use it, and for administrators how to operate it (setting up an ' +
    'institution, ingesting documents, onboarding users, assigning roles and access levels). ' +
    'Internally cascades through four tiers ' +
    'in order — this product\'s own documentation, then the institutional knowledge base, then live ' +
    'news as a fallback, then a domain-scoped ' +
    'web search as a last resort — stopping at the first tier that produces a genuine result. ' +
    'This is a single call: never call unibenNewsTool or webSearchTool yourself to "fill a gap" after ' +
    'this tool — it already tried them. ' +
    'The caller\'s role, trust level, and institution are attached server-side from the authenticated ' +
    'session — they are not parameters and cannot be chosen. ' +
    'When confidence=high, returns numbered source chunks for the agent to synthesize into a coherent answer. ' +
    'When confidence=low, all three tiers came up empty — the agent should acknowledge the gap and offer the user 2–3 concrete retrieval refinements as (A)/(B)/(C) options.',
  inputSchema: z.object({
    query: z.string().describe('The user question or topic to retrieve information about.'),
    programme: z
      .string()
      .optional()
      .describe(
        'Programme scope for retrieval e.g. "Computer Science", "Engineering". ' +
        'Normally read from system context field programme=<value>. ' +
        'Override with the programme the user explicitly requested if they selected a cross-context option. ' +
        'Omit only when genuinely unknown.'
      ),
    level: z
      .string()
      .optional()
      .describe(
        'Academic level scope e.g. "300L", "200L", "Postgraduate". ' +
        'Normally read from system context field level=<value>. ' +
        'Override with the level the user explicitly requested if they selected a cross-context option. ' +
        'Omit only when genuinely unknown.'
      ),
    department: z
      .string()
      .optional()
      .describe(
        'The user\'s department if different from their programme. ' +
        'Read from system context field dept=<value>. Omit if unknown.'
      ),
    related_topics: z
      .array(z.string())
      .max(3)
      .optional()
      .describe(
        'Up to 3 topic keywords from earlier in this conversation that are relevant to the current query. ' +
        'For example if the user previously asked about "registration deadlines" and now asks "what happens if I miss it?", ' +
        'pass ["registration deadlines"]. This boosts retrieval for follow-up questions. ' +
        'Omit if this is a new topic or first message.'
      ),
  }),
  outputSchema: z.object({
    answer: z
      .string()
      .describe(
        'When confidence=high: verified source chunks to synthesize from — numbered, each with a citation tag and source. ' +
        'When confidence=low: the abstention message to output verbatim.'
      ),
    confidence: z
      .enum(['high', 'low'])
      .describe(
        '"high" = a result was found at some tier (kb, news, or web) — synthesize a clear answer from ' +
        'the context, preserving all citation tags and following any caveat instructions embedded in it. ' +
        '"low" = all three tiers came up empty — the answer field is a NO_RESULTS signal. Write a ' +
        'response that acknowledges the gap and offers 2–3 concrete refinement options the user can choose from.'
      ),
    /**
     * Which tier actually produced this result — client-rendering metadata
     * only, withheld from the model (see toModelOutput). The model doesn't
     * need it: each tier's context text already embeds its own citation and
     * caveat instructions (e.g. buildWebContext's "state this is unverified").
     */
    tier: z.enum(['platform', 'kb', 'news', 'web', 'none']),
    /**
     * Structured source list for the client. The chat UI renders its Sources
     * list from THIS — never from the model's markdown — mirroring
     * unibenNewsTool's `posts` field. Withheld from the model; see
     * `toModelOutput`.
     */
    sources: z.array(z.object({
      number: z.number().int(),
      title:  z.string(),
      url:    z.string(),
      /** Page numbers (1-based) this source was cited from, sorted ascending.
       *  Only ever populated for tier "kb". */
      pages:  z.array(z.number().int()),
      /** ISO published date — only ever populated for tier "news". */
      published: z.string().optional(),
    })).describe('Source list for client rendering. Empty when confidence=low.'),
  }),
  /**
   * Withhold `sources` and `tier` from the model — see the comment on
   * buildGroundedContext. Must be a tagged tool-result envelope ({type,value}),
   * matching unibenNewsTool's toModelOutput (a bare object 422s against the provider).
   */
  toModelOutput: (output) => {
    const { answer, confidence } = output as { answer: string; confidence: 'high' | 'low' };
    return { type: 'json' as const, value: { answer, confidence } };
  },
  execute: async (inputData, context) => {
    const { query, programme, level, department, related_topics } =
      inputData as {
        query: string;
        programme?: string;
        level?: string;
        department?: string;
        related_topics?: string[];
      };

    // Security-critical values come ONLY from the server-injected session
    // context (chat-security middleware) — never from model-controlled input.
    const session = getSessionContext(context?.requestContext);
    const logger  = context?.mastra?.getLogger();

    const enrichedQuery = rewriteQuery(query, { programme, level, department, related_topics });

    // programme/level are relevance-disambiguation hints, never a security
    // boundary (role/trust/institution already cover that, unconditionally, on
    // every attempt below) — but passed as hard metadata filters, they can
    // silently exclude a document tagged for a different programme/level than
    // the caller's own. A postgraduate caller asking about undergraduate
    // admission criteria — to answer a student, out of curiosity, anything —
    // shouldn't have that content filtered out just because it doesn't match
    // their own profile. Same reasoning applies to enrichment prepended onto
    // the query text: a query about JAMB/UTME (undergraduate-only, per the
    // source document) embedded with "Postgraduate MSc Computer Science"
    // prepended gets pulled toward the wrong section of the very document that
    // answers it — deterministically, since that profile context never changes
    // for the caller.
    //
    // So both attempts go broad-first, narrow-as-fallback:
    //   1. Literal query, no programme/level filter — matches what any user,
    //      regardless of their own profile, would find asking this exact
    //      question within what their role/trust/institution already permit.
    //   2. Only if that comes up short: the enriched query AND the caller's
    //      own programme/level as a filter — correct for a genuinely vague,
    //      self-referential query ("my fees") that needs disambiguating.
    async function tryKb(q: string, scoped: boolean): Promise<KnowledgeRetrievalResponse> {
      try {
        return await retrieveKnowledge({
          query:              q,
          role:               session.role,
          roles:              session.roles,
          programme:          scoped ? programme : undefined,
          level:              scoped ? level      : undefined,
          trustLevel:         session.trustLevel,
          institutionId:      session.institutionId,
          namespaceAllowlist: session.namespaceAllowlist,
        });
      } catch (err) {
        logger?.warn('[groundedResponseTool] KB retrieval failed', { error: (err as Error).message, query: q });
        return { found: false, results: [], message: 'Retrieval failed.' };
      }
    }

    // ── Tier 0: platform documentation ───────────────────────────────────────
    // Served from Markdown on disk, not Pinecone. Ahead of the KB because the
    // two corpora answer disjoint questions — a question about Episteme has no
    // institutional answer — and because its coverage gate is strict enough
    // that an institutional question will not match it. A miss costs one
    // in-process scan of a few dozen sections, no network call.
    const platformHit = await searchPlatformDocs(
      query,
      resolvePlatformNamespaces({
        trustLevel: session.trustLevel,
        isPlatformAdmin: session.isPlatformAdmin,
      }),
      logger,
    );
    if (platformHit) {
      return {
        answer: platformHit.context,
        confidence: 'high' as const,
        tier: 'platform' as const,
        sources: platformHit.sources,
      };
    }

    // ── Tier 1: knowledge base — broad literal query first, scoped+enriched fallback ──
    let retrieval = await tryKb(query, false);

    if (!retrieval.found || retrieval.maxScore < RETRIEVAL_CONFIG.relevanceThreshold) {
      const scopedRetrieval = await tryKb(enrichedQuery, true);
      if (scopedRetrieval.found && scopedRetrieval.maxScore >= RETRIEVAL_CONFIG.relevanceThreshold) {
        retrieval = scopedRetrieval;
      }
    }

    // KB found results — but only surface them if the best score clears the relevance gate.
    // A maxScore below relevanceThreshold means retrieval found the "best available" match,
    // not a genuinely on-topic one. Treat it as not found and fall through to the next tier.
    if (retrieval.found && retrieval.maxScore >= RETRIEVAL_CONFIG.relevanceThreshold) {
      const { context: ctx, sources } = buildGroundedContext(retrieval);

      // "Relevant" is not the same as "current" — the top match may itself be
      // flagged stale (retrieveKnowledge's staleWarning, keyed off the source
      // document's age). A years-old handbook can clear the relevance gate on
      // a query like "who is the current VC" while being confidently wrong
      // about a fact that changes over time. Don't let it permanently mask a
      // fresher answer: try news, then web, and only fall back to this stale
      // content (still carrying its own caveat in `ctx`) if neither produces
      // anything.
      const topIsStale = retrieval.results[0]?.staleWarning != null;
      if (!topIsStale) {
        return { answer: ctx, confidence: 'high' as const, tier: 'kb' as const, sources };
      }

      const newsHit = await tryNewsFallback(query, logger);
      if (newsHit) return { answer: newsHit.answer, confidence: 'high' as const, tier: newsHit.tier, sources: newsHit.sources };

      const webHit = await tryWebFallback(query, logger);
      if (webHit) return { answer: webHit.answer, confidence: 'high' as const, tier: webHit.tier, sources: webHit.sources };

      return { answer: ctx, confidence: 'high' as const, tier: 'kb' as const, sources };
    }

    // Below the relevance gate entirely — same cascade, no stale content to fall back to.
    const newsHit = await tryNewsFallback(query, logger);
    if (newsHit) return { answer: newsHit.answer, confidence: 'high' as const, tier: newsHit.tier, sources: newsHit.sources };

    const webHit = await tryWebFallback(query, logger);
    if (webHit) return { answer: webHit.answer, confidence: 'high' as const, tier: webHit.tier, sources: webHit.sources };

    // ── Nothing found at any tier ────────────────────────────────────────────
    return {
      answer: buildAbstentionAnswer(query),
      confidence: 'low' as const,
      tier: 'none' as const,
      sources: [],
    };
  },
});
