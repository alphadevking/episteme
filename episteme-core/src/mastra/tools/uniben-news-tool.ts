import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { UNIBEN_NEWS_CONFIG } from '../config';

declare const process: { env: Record<string, string | undefined> };

// ── Types ─────────────────────────────────────────────────────────────────────

interface NewsResult {
    title: string;
    summary: string;
    url: string;
    published: string;
}

interface RssItem {
    title: string;
    link: string;
    pubDate: string;
    summary: string;
}

// ── HTML stripping ────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#8230;/g, '…')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// ── WP API fetch ──────────────────────────────────────────────────────────────
function parseRss(xml: string): RssItem[] {
    const items: RssItem[] = [];
    const itemBlocks = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];

    for (const block of itemBlocks) {
        const title = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
            ?? block.match(/<title>(.*?)<\/title>/)?.[1]
            ?? '';
        const link = block.match(/<link>(.*?)<\/link>/)?.[1]
            ?? block.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1]
            ?? '';
        const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? '';
        const desc = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1]
            ?? block.match(/<description>([\s\S]*?)<\/description>/)?.[1]
            ?? '';

        items.push({
            title: stripHtml(title).trim(),
            link: link.trim(),
            pubDate: pubDate.trim(),
            summary: stripHtml(desc).slice(0, 300).trim(),
        });
    }

    return items;
}

async function fetchNewsPosts(query: string): Promise<NewsResult[]> {
    const { maxResults, timeoutMs } = UNIBEN_NEWS_CONFIG;

    // Use the Worker URL and the Secret Key from your env
    const workerUrl = process.env['UNIBEN_NEWS_CLOUDFLARE_WORKER_URL']; 
    const proxyKey = process.env['UNIBEN_NEWS_CLOUDFLARE_PROXY_SECRET'];

    if (!workerUrl || !proxyKey) {
        throw new Error("Missing UNIBEN_NEWS_CLOUDFLARE_WORKER_URL or UNIBEN_NEWS_CLOUDFLARE_PROXY_SECRET");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let xml: string;

    try {
        const res = await fetch(workerUrl, {
            signal: controller.signal,
            headers: { 'x-episteme-proxy-key': proxyKey },
        });
        if (!res.ok) throw new Error(`Worker returned HTTP ${res.status}`);
        xml = await res.text();
    } finally {
        clearTimeout(timer);
    }

    // Now use the parseRss logic (which you should keep in the tool) 
    // to turn that XML into the NewsResult[] array.
    const items = parseRss(xml); 
    
    const queryTokens = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2);

    return items
        .map((item) => ({
            item,
            score: queryTokens.length === 0 ? 1
                : (() => {
                    const haystack = (item.title + ' ' + item.summary).toLowerCase();
                    const hits = queryTokens.filter((t) => haystack.includes(t));
                    return hits.length / queryTokens.length;
                })(),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map(({ item }) => ({
            id: 0,
            title: item.title,
            summary: item.summary,
            url: item.link,
            published: item.pubDate,
        }));
}

// ── Context builders ──────────────────────────────────────────────────────────

function buildNewsContext(results: NewsResult[]): string {
    const lines: string[] = [
        'LIVE NEWS — synthesize your answer from these posts only.',
        'These are fetched live from news.uniben.edu and reflect current information.',
        'Check the published date on each post — do not present past events as upcoming.',
        '',
    ];

    results.forEach((r, i) => {
        const published = new Date(r.published).toLocaleDateString('en-GB', {
            day: 'numeric', month: 'long', year: 'numeric',
        });
        lines.push(`[${i + 1}] ${r.title}`);
        lines.push(`    Published: ${published}`);
        lines.push(`    ${r.summary}`);
        lines.push(`    Source: ${r.url}`);
        lines.push('');
    });

    return lines.join('\n');
}

function buildNoNewsContext(query: string): string {
    return `NO_NEWS_RESULTS: No recent posts found on news.uniben.edu matching "${query}". Acknowledge this to the user and direct them to news.uniben.edu to check directly.`;
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export const unibenNewsTool = createTool({
    id: 'unibenNewsTool',
    description:
        'Fetches live news and announcements from news.uniben.edu. ' +
        'Use for questions about upcoming events, recent announcements, senate meetings, ' +
        'inaugural lectures, convocation, or anything requiring current information. ' +
        'Do NOT use groundedResponseTool for these — it contains static documents only.',
    inputSchema: z.object({
        query: z.string().describe(
            'The user\'s question or topic to search for. Pass naturally — e.g. "senate meeting", ' +
            '"upcoming events", "inaugural lecture". The tool handles search and ranking internally.',
        ),
    }),
    outputSchema: z.object({
        context: z.string().describe(
            'Numbered live posts to synthesize from, or a NO_NEWS_RESULTS signal. ' +
            'Always check published dates before answering.',
        ),
        found: z.boolean(),
        count: z.number().int(),
    }),
    execute: async (inputData) => {
        const { query } = inputData as { query: string };

        // console.log('[unibenNewsTool] query received:', query);

        let results: NewsResult[] = [];

        try {
            results = await fetchNewsPosts(query);
        } catch (err) {
            // console.error('[unibenNewsTool] fetch failed:', (err as Error).message);
            results = [];
        }

        // console.log('[unibenNewsTool] results after scoring:', results.length);

        if (results.length === 0) {
            return { context: buildNoNewsContext(query), found: false, count: 0 };
        }

        return { context: buildNewsContext(results), found: true, count: results.length };
    },
});