import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { WEB_SEARCH_CONFIG } from '../config';

declare const process: { env: Record<string, string | undefined> };

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export type WebSearchResponse =
  | { found: true; results: WebSearchResult[] }
  | { found: false; results: []; message: string };

interface TavilyResponse {
  results: Array<{ title: string; url: string; content: string; score: number }>;
}

/**
 * Tavily-powered web search scoped to Uniben and Nigerian academic authorities.
 * Returns clean, LLM-ready content (not raw HTML) — Tavily extracts and filters for us.
 * Domain scope is tunable via WEB_SEARCH_INCLUDE_DOMAINS env var.
 */
export async function searchWeb(query: string): Promise<WebSearchResponse> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: getEnv('TAVILY_API_KEY'),
      query,
      search_depth: WEB_SEARCH_CONFIG.searchDepth,
      include_domains: WEB_SEARCH_CONFIG.includeDomains.length > 0
        ? WEB_SEARCH_CONFIG.includeDomains
        : undefined,
      max_results: WEB_SEARCH_CONFIG.maxResults,
      include_raw_content: false,
      include_answer: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as TavilyResponse;

  if (!data.results || data.results.length === 0) {
    return { found: false, results: [], message: 'No web results found for this query.' };
  }

  // Filter by score threshold and normalise shape
  const filtered = data.results
    .filter((r) => r.score >= WEB_SEARCH_CONFIG.scoreThreshold)
    .map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
    }));

  if (filtered.length === 0) {
    return { found: false, results: [], message: 'No high-confidence web results found.' };
  }

  return { found: true, results: filtered };
}

export const webSearchTool = createTool({
  id: 'webSearchTool',
  description:
    'Searches the web for up-to-date information about the University of Benin (Uniben), ' +
    'Faculty of Computing, Nigerian academic regulations, JAMB, NUC, TETFund, or any topic ' +
    'not yet in the internal knowledge base. ' +
    'Use as a supplementary source when the knowledge base returns no results ' +
    'or when the query requires current, real-time information.',
  inputSchema: z.object({
    query: z.string().describe('The search query to look up on the web.'),
  }),
  execute: async (inputData) => {
    const { query } = inputData as { query: string };
    return await searchWeb(query);
  },
});
