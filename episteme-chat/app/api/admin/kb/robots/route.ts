// app/api/admin/kb/robots/route.ts
// robots.txt verdicts for a batch of harvest URLs.
//
// WHY A ROUTE AT ALL: the browser cannot fetch https://uniben.edu/robots.txt —
// it is cross-origin with no CORS header, and uniben.edu 403s anything but the
// Cloudflare Worker anyway. The parser (lib/harvest/robots.ts) and the gate
// (lib/harvest/gate.ts) are the same modules the CLI uses; this route only
// gives them a place to run where the fetch is possible.
//
// WHY BATCHED: robots.txt is per-origin, so 26 pages across 3 hosts need 3
// fetches, not 26. Taking the whole list in one request is what makes that
// caching possible at all — a stateless per-URL route would re-fetch every
// time. It also means the free, polite check costs one round trip before the
// per-page loop starts.
//
// FAIL CLOSED: an origin whose robots.txt cannot be read refuses every page on
// that origin. See verdictFor.

import { assertKbAdmin, kbAdminHeaders, mastraBaseUrl } from "@/lib/admin/kb-auth";
import { groupByOrigin, USER_AGENT, verdictFor, type UrlVerdict } from "@/lib/harvest/gate";
import { parseRobotsTxt, type RobotsTxt } from "@/lib/harvest/robots";

// A handful of origins, each bounded by core's 15s fetch timeout.
export const maxDuration = 60;

/** Refuse an absurd batch rather than sitting on it. The manifest is ~26 URLs. */
const MAX_URLS = 500;

/** What was learned about one origin, so the operator can see the rules applied. */
interface OriginReport {
  origin: string;
  readable: boolean;
  ruleCount: number;
  crawlDelay: number | null;
  /** Set when the file could not be read. */
  error?: string;
}

export async function POST(req: Request) {
  let body: { urls?: unknown; scope?: { institutionId?: string | null } };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { error, institutionId } = await assertKbAdmin(body.scope?.institutionId);
  if (error) return error;

  const urls = body.urls;
  if (!Array.isArray(urls) || urls.some((u) => typeof u !== "string")) {
    return Response.json({ error: "Missing required field: urls (string[])" }, { status: 400 });
  }
  if (urls.length > MAX_URLS) {
    return Response.json({ error: `Too many URLs (${urls.length} > ${MAX_URLS})` }, { status: 400 });
  }

  const headers = { "Content-Type": "application/json", ...kbAdminHeaders(institutionId) };

  async function robotsFor(origin: string): Promise<{ robots: RobotsTxt | null; error?: string }> {
    try {
      const res = await fetch(`${mastraBaseUrl()}/kb/fetch`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url: `${origin}/robots.txt` }),
      });
      const data = (await res.json()) as { html?: string; error?: string };
      if (!res.ok || typeof data.html !== "string") {
        return { robots: null, error: data.error ?? `HTTP ${res.status}` };
      }
      return { robots: parseRobotsTxt(data.html, USER_AGENT) };
    } catch (err) {
      return { robots: null, error: String(err) };
    }
  }

  const groups = groupByOrigin(urls as string[]);
  const verdicts: Record<string, UrlVerdict> = {};
  const origins: OriginReport[] = [];

  // Sequential: a handful of origins, and hammering them in parallel to save a
  // second would be an odd way to open a crawl that is trying to be polite.
  for (const [origin, originUrls] of groups) {
    const { robots, error: readError } = await robotsFor(origin);

    origins.push({
      origin,
      readable: robots !== null,
      ruleCount: robots?.rules.length ?? 0,
      crawlDelay: robots?.crawlDelay ?? null,
      ...(readError ? { error: readError } : {}),
    });

    for (const url of originUrls) verdicts[url] = verdictFor(robots, url);
  }

  // URLs that never made it into a group could not be parsed at all. They get
  // an explicit refusal rather than being silently absent from the response —
  // a missing verdict is the one shape a caller could mistake for permission.
  for (const url of urls as string[]) {
    if (!(url in verdicts)) {
      verdicts[url] = { allowed: false, reason: "not a valid URL", delayMs: 0 };
    }
  }

  return Response.json({ verdicts, origins });
}
