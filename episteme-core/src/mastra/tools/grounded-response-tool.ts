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
import { listReachableSources } from './corpus-manifest';
import { buildAbstentionAnswer } from './abstention';
import { resolvePlatformNamespaces } from '../security/retrieval-gate';
import { documentSource, sourceSchema, type Source } from './source';
import { buildGroundedContext } from './grounded-context';
import { clearsRelevanceGate } from './relevance-gate';

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


/**
 * Unified source shape across every tier this tool can resolve from — defined
 * in ./source.ts so the platform tier and the record tools cannot drift from it.
 * `pages` is only populated for paginated KB documents, `published` only for
 * news, and `url` is absent for sources that are not linkable at all.
 */
type UnifiedSource = Source;

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

  const sources: UnifiedSource[] = newsPosts.map((p, i) =>
    documentSource({ number: i + 1, title: p.title, url: p.url, published: p.published }),
  );
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

  const sources: UnifiedSource[] = webFound.map((r, i) =>
    documentSource({ number: i + 1, title: r.title, url: r.url }),
  );
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
    sources: z.array(sourceSchema)
      .describe('Source list for client rendering. Empty when confidence=low.'),
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

    // ── Tier 1: knowledge base — broad literal query first, scoped+enriched fallback ──
    //
    // AHEAD OF THE PLATFORM DOCS since 2026-08-02. It used to run second, on the
    // assumption that the two corpora answer disjoint questions and the platform
    // coverage gate was strict enough to keep institutional questions out. The
    // eval's cascade tier disproved that: "what are the admission requirements"
    // — the single most common prospective-student question — resolved to
    // tier=platform, matching help/getting-started.md because its "What it can
    // answer" section LISTS admissions as an example question. A product doc
    // that advertises a question outranked the verified document that answers
    // it.
    //
    // Institutional content is authoritative for institutional questions, so it
    // goes first, and platform docs catch what it misses. A genuine platform
    // question ("how do I ingest a document") has no institutional match and
    // falls through cleanly — the relevance gate is what makes that safe.
    // Cost: one embedding + Pinecone round-trip on platform questions that
    // previously short-circuited in-process.
    let retrieval = await tryKb(query, false);

    if (!clearsRelevanceGate(retrieval, RETRIEVAL_CONFIG.relevanceThreshold)) {
      const scopedRetrieval = await tryKb(enrichedQuery, true);
      if (clearsRelevanceGate(scopedRetrieval, RETRIEVAL_CONFIG.relevanceThreshold)) {
        retrieval = scopedRetrieval;
      }
    }

    // KB found results — but only surface them if the best score clears the relevance gate.
    // A maxScore below relevanceThreshold means retrieval found the "best available" match,
    // not a genuinely on-topic one. Treat it as not found and fall through to the next tier.
    if (clearsRelevanceGate(retrieval, RETRIEVAL_CONFIG.relevanceThreshold)) {
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

      // ── AUTHORITY BEFORE FRESHNESS ────────────────────────────────────────
      //
      // A stale KB match may be superseded ONLY by dated official news — never
      // by web search.
      //
      // This block used to try web as well, and that quietly disabled most of
      // the knowledge base. STUDENTHANDBOOK.pdf is dated 2022-12-19 and is 391
      // of the corpus's 454 vectors, so with a 365-day freshness threshold
      // EVERY handbook-backed answer was stale, and every one of them was
      // handed to web search instead. A user asking "what are the examination
      // rules" got a third-party page prefaced with "these sources are external
      // and unverified" while the university's own handbook — retrieved,
      // relevant at 0.794, and citable by page number — sat unused.
      //
      // Freshness is not authority. A newer document is better evidence only
      // when it is comparably authoritative; a random allowlisted page is not
      // more authoritative than the institution's own handbook. Age is already
      // communicated honestly through staleWarning, which travels with `ctx` —
      // that is the right place to express "this may be out of date", rather
      // than silently preferring a weaker source.
      //
      // News keeps its precedence because it is BOTH dated and official, which
      // is exactly the case the divert was built for: "who is the current vice
      // chancellor" answered from a 2022 handbook. That still works — the news
      // tier holds the announcement — and now it is the only thing that can
      // outrank the corpus.
      const newsHit = await tryNewsFallback(query, logger);
      if (newsHit) return { answer: newsHit.answer, confidence: 'high' as const, tier: newsHit.tier, sources: newsHit.sources };

      return { answer: ctx, confidence: 'high' as const, tier: 'kb' as const, sources };
    }

    // ── Tier 2: platform documentation ───────────────────────────────────────
    // Markdown on disk, no network call. Reached only when the institutional
    // corpus had no confident answer, so a question about Episteme itself lands
    // here while an institutional question can no longer be captured by a
    // product doc that merely mentions the topic.
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

    // Below the relevance gate entirely — same cascade, no stale content to fall back to.
    const newsHit = await tryNewsFallback(query, logger);
    if (newsHit) return { answer: newsHit.answer, confidence: 'high' as const, tier: newsHit.tier, sources: newsHit.sources };

    const webHit = await tryWebFallback(query, logger);
    if (webHit) return { answer: webHit.answer, confidence: 'high' as const, tier: webHit.tier, sources: webHit.sources };

    // ── Nothing found at any tier ────────────────────────────────────────────
    // Only here — after every tier has failed — do we spend a probe discovering
    // what this caller CAN read. On the answering paths it would be pure cost;
    // on this one it is the difference between offering real alternatives and
    // inviting the model to invent them. Bounded by the same gate as retrieval,
    // and fails soft to [] (see corpus-manifest.ts).
    const reachable = await listReachableSources(
      {
        roles:      session.roles,
        trustLevel: session.trustLevel,
        ...(session.institutionId      ? { institutionId:      session.institutionId } : {}),
        ...(session.namespaceAllowlist ? { namespaceAllowlist: session.namespaceAllowlist } : {}),
      },
      logger,
    );

    return {
      answer: buildAbstentionAnswer(query, reachable),
      confidence: 'low' as const,
      tier: 'none' as const,
      sources: [],
    };
  },
});
