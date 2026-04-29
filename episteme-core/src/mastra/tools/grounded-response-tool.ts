import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  retrieveKnowledge,
  type KnowledgeRetrievalResponse,
} from './knowledge-retrieval-tool';
import { RETRIEVAL_CONFIG } from '../config';

const UserRole = z
  .enum(['prospective', 'student', 'parent', 'staff', 'hod'])
  .default('prospective');

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

function buildGroundedContext(retrieval: KnowledgeRetrievalResponse & { found: true }): string {
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
    'After your complete answer body, output a ## Sources section as a numbered markdown list copied exactly from the SOURCES LIST below.',
  ];

  if (staleWarnings.length > 0) lines.push('', ...staleWarnings);

  retrieval.results.forEach((r) => {
    const src = sourceIndex.get(r.source)!;
    lines.push('');
    lines.push(`[Source ${src.number}] ${r.content}`);
  });

  lines.push('');
  lines.push('SOURCES LIST (copy exactly into ## Sources):');
  for (const [url, { number, title }] of sourceIndex) {
    lines.push(`${number}. [${title}](${url})`);
  }

  return lines.join('\n');
}

function buildAbstentionAnswer(query: string): string {
  return `NO_RESULTS: The knowledge base does not contain verified information matching this query ("${query}"). Use this signal to acknowledge the gap and offer the user 2–3 concrete retrieval refinements based on their context and what was asked.`;
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const groundedResponseTool = createTool({
  id: 'groundedResponseTool',
  description:
    'Retrieves role-appropriate verified knowledge chunks from the institutional knowledge base. ' +
    'When confidence=high, returns numbered source chunks for the agent to synthesize into a coherent answer. ' +
    'When confidence=low, returns a NO_RESULTS signal — the agent should acknowledge the gap and offer the user 2–3 concrete retrieval refinements as (A)/(B)/(C) options.',
  inputSchema: z.object({
    query: z.string().describe('The user question or topic to retrieve information about.'),
    role: UserRole.describe(
      'The authenticated role of the user. Defaults to prospective student if unknown.'
    ),
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
    trust_level: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .describe(
        'The user\'s verified trust level (1–4). ' +
        'Read from system context field trust_level=<value>. Defaults to 1 (public-only). ' +
        'This is a hard security gate — do not infer or guess this value.'
      ),
    institution_id: z
      .string()
      .optional()
      .describe(
        'Institution UUID from session context. ' +
        'Read from system context field institution_id=<value>. ' +
        'Pass this through to scope retrieval to the correct institution\'s documents.'
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
  }),
  execute: async (inputData) => {
    const { query, role, programme, level, department, related_topics, trust_level, institution_id } =
      inputData as {
        query: string;
        role: string;
        programme?: string;
        level?: string;
        department?: string;
        related_topics?: string[];
        trust_level?: number;
        institution_id?: string;
      };

    const enrichedQuery = rewriteQuery(query, { programme, level, department, related_topics });

    const retrieval = await retrieveKnowledge({
      query:         enrichedQuery,
      role:          role as z.infer<typeof UserRole>,
      programme,
      level,
      trustLevel:    trust_level ?? 1,
      institutionId: institution_id,
    });

    // KB found results — but only surface them if the best score clears the relevance gate.
    // A maxScore below relevanceThreshold means retrieval found the "best available" match,
    // not a genuinely on-topic one. Treat it as not found rather than mislead with off-topic chunks.
    if (retrieval.found && retrieval.maxScore >= RETRIEVAL_CONFIG.relevanceThreshold) {
      return {
        answer: buildGroundedContext(retrieval),
        confidence: 'high' as const,
      };
    }

    // No results, or best match below relevance threshold — return abstention. No web fallback.
    return {
      answer: buildAbstentionAnswer(query),
      confidence: 'low' as const,
    };
  },
});
