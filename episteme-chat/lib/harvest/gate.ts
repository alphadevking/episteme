// lib/harvest/gate.ts
/**
 * The rules that decide whether a harvest may fetch a page, and whether what
 * came back is worth ingesting.
 *
 * These lived inside scripts/harvest.ts as local helpers. The admin harvest UI
 * needs exactly the same decisions, and a second implementation of "may we
 * fetch this" is how a UI ends up politer or ruder than the CLI without anyone
 * choosing that. So the CLI and the UI now import the same functions, and this
 * file is where the crawl's manners are defined once.
 *
 * FAIL CLOSED throughout: an unreadable robots.txt refuses the host rather than
 * assuming permission. See robots.ts for the same principle in the parser.
 */
import { isAllowed, robotsPath, type RobotsTxt } from './robots';

/**
 * Identify ourselves honestly in robots matching. We cannot set the header the
 * origin sees — the Cloudflare Worker makes the actual request — but the rules
 * we obey should be the ones written for a bot, not the ones written for a
 * browser.
 */
export const USER_AGENT = 'EpistemeHarvester';

/** Space out requests. Overridden upward by a Crawl-delay if robots declares one. */
export const DEFAULT_DELAY_MS = 1_500;

/**
 * Below this many characters of visible text, a fetched page is treated as a
 * failure rather than a thin success.
 *
 * The failure it catches: cleaning strips a page to its chrome and leaves no
 * prose. That ingests cleanly, embeds cleanly, and silently pollutes retrieval
 * with a document that answers nothing — the most expensive kind of pass.
 */
export const THIN_TEXT_CHARS = 400;

export interface UrlVerdict {
  allowed: boolean;
  /** Present only when `allowed` is false. Shown to the operator verbatim. */
  reason?: string;
  /** How long to wait after a request to this origin before the next one. */
  delayMs: number;
}

/** The origin robots.txt is scoped to. Throws on an unparseable URL. */
export function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * Gate one URL against its origin's robots.txt.
 *
 * `robots === null` means the file could not be read, which is a refusal, not
 * a default-allow. Proceeding because a network blip hid the rules is exactly
 * how a well-meaning crawler ends up somewhere it was told not to go.
 */
export function verdictFor(robots: RobotsTxt | null, url: string): UrlVerdict {
  if (robots === null) {
    return {
      allowed: false,
      reason: 'robots.txt could not be read — refusing to guess',
      delayMs: DEFAULT_DELAY_MS,
    };
  }

  const delayMs = Math.max(DEFAULT_DELAY_MS, (robots.crawlDelay ?? 0) * 1000);

  if (!isAllowed(robots, robotsPath(url))) {
    return { allowed: false, reason: 'disallowed by robots.txt', delayMs };
  }

  return { allowed: true, delayMs };
}

/**
 * Bucket URLs by origin so robots.txt is fetched once per host, not once per
 * page. Order within a bucket is preserved; unparseable URLs are dropped here
 * and reported by the caller, which knows how to show them.
 */
export function groupByOrigin(urls: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    let origin: string;
    try {
      origin = originOf(url);
    } catch {
      continue;
    }
    const bucket = groups.get(origin);
    if (bucket) bucket.push(url);
    else groups.set(origin, [url]);
  }
  return groups;
}

/**
 * Visible-text length of fetched HTML — what the extractor will actually see.
 *
 * Deliberately not the byte count: a page can be 40 KB of markup wrapping two
 * sentences, and the byte count calls that a healthy fetch.
 */
export function textLengthOf(html: string): number {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

export function isThin(textLength: number): boolean {
  return textLength < THIN_TEXT_CHARS;
}
