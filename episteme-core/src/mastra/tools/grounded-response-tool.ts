import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  retrieveKnowledge,
  type KnowledgeRetrievalResponse,
} from './knowledge-retrieval-tool';
import { RETRIEVAL_CONFIG } from '../config';
import { getSessionContext } from '../server/session-context';

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

type GroundedSource = { number: number; title: string; url: string };

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
): { context: string; sources: GroundedSource[] } {
  const staleWarnings = Array.from(
    new Set(retrieval.results.map((r) => r.staleWarning).filter((w): w is string => Boolean(w)))
  );

  // Deduplicate sources by URL so multiple chunks from the same document share one citation number
  const sourceIndex = new Map<string, { number: number; title: string }>();
  let sourceCount = 0;
  for (const r of retrieval.results) {
    if (!sourceIndex.has(r.source)) {
      sourceCount++;
      sourceIndex.set(r.source, { number: sourceCount, title: deriveTitle(r.source) });
    }
  }

  const lines: string[] = [
    'VERIFIED SOURCES — synthesize your answer exclusively from these chunks.',
    'Cite each fact inline as [N](cite:N) where N is the source number shown below (e.g. [1](cite:1)).',
    'The reader sees a numbered source list rendered below your answer automatically — do not add a',
    '## Sources section, do not restate the list, and do not paste any URL into your answer.',
  ];

  if (staleWarnings.length > 0) lines.push('', ...staleWarnings);

  retrieval.results.forEach((r) => {
    const src = sourceIndex.get(r.source)!;
    lines.push('');
    lines.push(`[Source ${src.number}] ${r.content}`);
  });

  const sources: GroundedSource[] = Array.from(
    sourceIndex,
    ([url, { number, title }]) => ({ number, title, url }),
  );

  return { context: lines.join('\n'), sources };
}

function buildAbstentionAnswer(query: string): string {
  return `NO_RESULTS: The knowledge base does not contain verified information matching this query ("${query}"). Use this signal to acknowledge the gap and offer the user 2–3 concrete retrieval refinements based on their context and what was asked.`;
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const groundedResponseTool = createTool({
  id: 'groundedResponseTool',
  description:
    'Retrieves role-appropriate verified knowledge chunks from the institutional knowledge base. ' +
    'The caller\'s role, trust level, and institution are attached server-side from the authenticated ' +
    'session — they are not parameters and cannot be chosen. ' +
    'When confidence=high, returns numbered source chunks for the agent to synthesize into a coherent answer. ' +
    'When confidence=low, returns a NO_RESULTS signal — the agent should acknowledge the gap and offer the user 2–3 concrete retrieval refinements as (A)/(B)/(C) options.',
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
        '"high" = verified KB chunks returned — synthesize a clear answer from them, preserving all citation tags. ' +
        '"low" = no results found — the answer field is a NO_RESULTS signal. Write a response that acknowledges the gap and offers 2–3 concrete refinement options the user can choose from.'
      ),
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
    })).describe('Source list for client rendering. Empty when confidence=low.'),
  }),
  /**
   * Withhold `sources` from the model — see the comment on buildGroundedContext.
   * Must be a tagged tool-result envelope ({type,value}), matching
   * unibenNewsTool's toModelOutput (a bare object 422s against the provider).
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

    const enrichedQuery = rewriteQuery(query, { programme, level, department, related_topics });

    const retrieval = await retrieveKnowledge({
      query:              enrichedQuery,
      role:               session.role,
      programme,
      level,
      trustLevel:         session.trustLevel,
      institutionId:      session.institutionId,
      namespaceAllowlist: session.namespaceAllowlist,
    });

    // KB found results — but only surface them if the best score clears the relevance gate.
    // A maxScore below relevanceThreshold means retrieval found the "best available" match,
    // not a genuinely on-topic one. Treat it as not found rather than mislead with off-topic chunks.
    if (retrieval.found && retrieval.maxScore >= RETRIEVAL_CONFIG.relevanceThreshold) {
      const { context, sources } = buildGroundedContext(retrieval);
      return {
        answer: context,
        confidence: 'high' as const,
        sources,
      };
    }

    // No results, or best match below relevance threshold — return abstention. No web fallback.
    return {
      answer: buildAbstentionAnswer(query),
      confidence: 'low' as const,
      sources: [],
    };
  },
});
