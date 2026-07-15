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

// Below this length, the RSS excerpt is embed-only ("Watch Live:", a flyer
// caption, etc.) — deep-fetching the article page won't yield more text,
// since the real content lives in an embedded video/image, not in markup.
const MIN_CONTENT_LENGTH = 50;

// Cap deep-fetched article text to control token cost per tool call.
const MAX_ARTICLE_CHARS = 2000;

function isThinContent(text: string): boolean {
    return text.trim().length < MIN_CONTENT_LENGTH;
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

// ── Article deep-fetch ────────────────────────────────────────────────────────
// Reuses the same Worker (already bypasses Cloudflare) with a ?url= param
// to fetch full article HTML for posts that have substantive RSS content.

function extractArticleText(html: string): string {
    // Strip non-content blocks first regardless of selector success —
    // these would otherwise leak into the fallback path.
    const cleaned = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<head[\s\S]*?<\/head>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ');

    // Try the WordPress entry-content wrapper first — best signal-to-noise.
    const match = cleaned.match(
        /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/article|<footer|<div[^>]*class="[^"]*(?:comments|sharedaddy|jp-relatedposts))/i,
    );
    console.log('[unibenNewsTool] entry-content matched:', !!match?.[1]);
    if (match?.[1]) {
        return stripHtml(match[1]).slice(0, MAX_ARTICLE_CHARS);
    }

    // Fallback — strip the body only, never the full document
    const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const raw = bodyMatch?.[1] ?? cleaned;
    return stripHtml(raw).slice(0, MAX_ARTICLE_CHARS);
}

async function fetchArticleContent(
    articleUrl: string,
    workerUrl: string,
    proxyKey: string,
    timeoutMs: number,
): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${workerUrl}?url=${encodeURIComponent(articleUrl)}`, {
            signal: controller.signal,
            headers: { 'x-episteme-proxy-key': proxyKey },
        });
        if (!res.ok) return null;
        const html = await res.text();
        return extractArticleText(html);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
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

    const topItems = items
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
        .slice(0, maxResults);

    return Promise.all(
        topItems.map(async ({ item }) => {
            if (isThinContent(item.summary)) {
                return {
                    title: item.title,
                    summary: `${item.title} — full details (including any live stream or flyer) are on the linked page, not available as text.`,
                    url: item.link,
                    published: item.pubDate,
                };
            }

            const fullText = await fetchArticleContent(item.link, workerUrl, proxyKey, timeoutMs);
            return {
                title: item.title,
                summary: fullText ?? item.summary,
                url: item.link,
                published: item.pubDate,
            };
        }),
    );
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