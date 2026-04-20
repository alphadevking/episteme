import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  retrieveKnowledge,
  type KnowledgeRetrievalResponse,
} from './knowledge-retrieval-tool';

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

function buildGroundedAnswer(retrieval: KnowledgeRetrievalResponse & { found: true }): string {
  const staleWarnings = Array.from(
    new Set(retrieval.results.map((r) => r.staleWarning).filter((w): w is string => Boolean(w)))
  );

  const lines: string[] = [];
  if (staleWarnings.length > 0) lines.push(...staleWarnings, '');

  for (const r of retrieval.results) {
    lines.push(`${r.content} [${r.chunkId}]`);
    lines.push(`(Source: ${r.source}; Updated: ${r.updatedAt})`);
    lines.push('');
  }

  lines.push('Is there anything else I can help you with?');
  return lines.join('\n').trimEnd();
}

function buildAbstentionAnswer(): string {
  return [
    'I do not have verified information in the official documentation to answer that question.',
    '',
    'For accurate details, please contact the relevant faculty office directly.',
    '',
    'Is there anything else I can help you with?',
  ].join('\n');
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const groundedResponseTool = createTool({
  id: 'groundedResponseTool',
  description:
    'Returns a strictly grounded answer built ONLY from retrieved, role-appropriate verified knowledge chunks. ' +
    'The output is extractive: it only repeats retrieved content verbatim and attaches chunk citations and sources.',
  inputSchema: z.object({
    query: z.string().describe('The user question or topic to retrieve information about.'),
    role: UserRole.describe(
      'The authenticated role of the user. Defaults to prospective student if unknown.'
    ),
    programme: z
      .string()
      .optional()
      .describe(
        'The user\'s student programme e.g. "Computer Science". ' +
        'Read from system context field programme=<value>. Omit for prospective users.'
      ),
    level: z
      .string()
      .optional()
      .describe(
        'The user\'s academic level e.g. "300L". ' +
        'Read from system context field level=<value>. Omit if unknown.'
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
        'A grounded, citation-bearing answer. Output this verbatim without modification.'
      ),
    confidence: z
      .enum(['high', 'low'])
      .describe(
        '"high" = answer from verified KB. ' +
        '"low" = no results found — abstention message only, do not supplement.'
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

    // KB found authoritative results
    if (retrieval.found) {
      return {
        answer: buildGroundedAnswer(retrieval),
        confidence: 'high' as const,
      };
    }

    // Nothing in the KB — return abstention. No web fallback.
    return {
      answer: buildAbstentionAnswer(),
      confidence: 'low' as const,
    };
  },
});
