/**
 * Uniben content proxy — Cloudflare Worker.
 *
 * Purpose: fetch uniben.edu content that sits behind Cloudflare's bot
 * protection (which 403s direct server-to-server fetches). Two consumers, one
 * job:
 *   - the live news tool (base URL, no ?url= → the news RSS feed), and
 *   - KB URL ingestion (?url=<uniben page> → that page's HTML).
 * See episteme-core/src/mastra/tools/uniben-news-tool.ts and ingestion/url-fetcher.ts.
 *
 * This file is the source of truth for the deployed Worker — keep it in sync
 * with the Cloudflare dashboard. Deploy with `wrangler deploy` or by pasting it
 * into the dashboard editor.
 *
 * Security model:
 *   - Shared-secret auth: caller must send `x-episteme-proxy-key` matching the
 *     PROXY_SECRET binding. The app sends UNIBEN_NEWS_CLOUDFLARE_PROXY_SECRET.
 *   - GET only — this is a read proxy; it never relays a mutating method.
 *   - Host allowlist: only the uniben.edu family (apex + any subdomain) over
 *     http(s). Without this a leaked key would make it an open SSRF relay. The
 *     server mirrors the same allowlist in url-fetcher.ts (defense in depth).
 *
 * Env binding (Cloudflare → Settings → Variables):
 *   PROXY_SECRET  — the shared secret; must equal the app's
 *                   UNIBEN_NEWS_CLOUDFLARE_PROXY_SECRET.
 */
export default {
  async fetch(request, env, ctx) {
    try {
      const proxySecret = env.PROXY_SECRET;
      const authHeader = request.headers.get('x-episteme-proxy-key');

      if (!proxySecret || !authHeader || authHeader !== proxySecret) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Read proxy only — never relay a mutating method.
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Accept an optional ?url= param, default to the news feed.
      const reqUrl = new URL(request.url);
      const targetParam = reqUrl.searchParams.get('url');
      const targetUrl = targetParam ?? 'https://news.uniben.edu/feed/';

      let parsedTarget;
      try {
        parsedTarget = new URL(targetUrl);
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid url param' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Only http(s), and only the uniben.edu family (apex + any subdomain).
      // endsWith('.uniben.edu') matches www./news./etc. but NOT look-alikes
      // like evil-uniben.edu (ends with "-uniben.edu") or uniben.edu.evil.com.
      const host = parsedTarget.hostname.toLowerCase();
      const isUniben = host === 'uniben.edu' || host.endsWith('.uniben.edu');
      const isHttp = parsedTarget.protocol === 'https:' || parsedTarget.protocol === 'http:';
      if (!isHttp || !isUniben) {
        return new Response(JSON.stringify({ error: 'Host not allowed' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const response = await fetch(parsedTarget.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/xml,application/xml,application/xhtml+xml,text/html',
        },
      });

      if (!response.ok) {
        return new Response(`Upstream error: ${response.status}`, { status: response.status });
      }

      // Echo upstream content-type — feed is XML, article/page responses are HTML.
      const contentType = response.headers.get('Content-Type') ?? 'text/html';

      return new Response(response.body, {
        headers: {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
        },
      });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
