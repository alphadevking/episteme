// URL ingestion — fetch a uniben.edu page's HTML through the Cloudflare Worker
// proxy (the same one the news tool uses) so Cloudflare's bot protection doesn't
// 403 us, then hand the HTML to the normal ingestion pipeline as if it were an
// uploaded .html file.
//
// Defense-in-depth: even though the Worker should allowlist hosts itself, we
// ALSO refuse any non-uniben.edu host here. A proxy that will fetch an arbitrary
// `?url=` is an SSRF relay if its key ever leaks; two independent allowlists
// mean neither side alone can be turned into one.
import { createHash } from 'node:crypto';

declare const process: { env: Record<string, string | undefined> };

/** Only these hosts may be ingested by URL. Matches uniben.edu and any subdomain
 *  (www., news., etc.) but NOT look-alikes like evil-uniben.edu or uniben.edu.x. */
const UNIBEN_HOST = /(^|\.)uniben\.edu$/i;

const FETCH_TIMEOUT_MS = 15_000;
/** Hard cap on fetched HTML — a runaway page must not blow up ingestion. */
const MAX_BYTES = 5_000_000;

export interface FetchedPage {
  /** Raw page HTML, fed to the document processor as an .html file. */
  html: string;
  /** SHA-256 of the HTML — stored so a future freshness check can detect change. */
  contentHash: string;
  /** The normalized URL actually fetched. */
  url: string;
}

/**
 * Validate a URL for ingestion: http(s) only, host must be uniben.edu (or a
 * subdomain). Returns the normalized URL or throws with a user-facing message.
 */
export function assertIngestableUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Not a valid URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must start with http:// or https://');
  }
  if (!UNIBEN_HOST.test(parsed.hostname)) {
    throw new Error(`Only uniben.edu pages can be ingested by URL (got "${parsed.hostname}").`);
  }
  return parsed;
}

/**
 * Fetch a uniben.edu page's HTML via the Cloudflare Worker proxy.
 * Throws a clear, user-facing error on any failure (missing config, blocked
 * host, non-200, empty/oversized body) so the ingest SSE stream can surface it.
 */
export async function fetchUnibenPage(rawUrl: string): Promise<FetchedPage> {
  const workerUrl = process.env['UNIBEN_NEWS_CLOUDFLARE_WORKER_URL'];
  const proxyKey  = process.env['UNIBEN_NEWS_CLOUDFLARE_PROXY_SECRET'];
  if (!workerUrl || !proxyKey) {
    throw new Error('URL ingestion is not configured (missing Cloudflare Worker proxy env).');
  }

  const target = assertIngestableUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${workerUrl}?url=${encodeURIComponent(target.href)}`, {
      signal:  controller.signal,
      headers: { 'x-episteme-proxy-key': proxyKey },
    });
    if (!res.ok) {
      throw new Error(`Proxy could not fetch the page (HTTP ${res.status}). If this is a uniben.edu page the Worker may not allow this host yet.`);
    }
    const html = await res.text();
    if (!html || html.trim().length === 0) {
      throw new Error('The page returned no content.');
    }
    if (html.length > MAX_BYTES) {
      throw new Error('The page is too large to ingest.');
    }
    const contentHash = createHash('sha256').update(html).digest('hex');
    return { html, contentHash, url: target.href };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Timed out fetching the page.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Derive a sensible .html filename from a URL path, for display/extraction. */
export function fileNameFromUrl(rawUrl: string): string {
  try {
    const { hostname, pathname } = new URL(rawUrl);
    const last = pathname.split('/').filter(Boolean).pop();
    const base = (last && last.replace(/\.(x?html?|aspx?|php)$/i, '')) || hostname.replace(/^www\./, '');
    return `${base}.html`;
  } catch {
    return 'page.html';
  }
}
