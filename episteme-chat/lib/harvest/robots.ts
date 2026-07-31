// lib/harvest/robots.ts
/**
 * A small robots.txt parser, used to gate the uniben.edu harvest.
 *
 * Why this exists rather than a one-off manual read: a person checking
 * robots.txt once, before a harvest, checks it for the pages they thought to
 * look at, on the day they looked. The site can add a Disallow next week and a
 * re-run would not notice. Enforcing it in the runner means every fetch — the
 * first harvest and every re-harvest after it — is checked against the file as
 * it is right now.
 *
 * Scope: the subset of the standard that matters for a small allowlisted
 * crawl — User-agent grouping, Allow, Disallow, and `*`/`$` wildcards, with
 * longest-match-wins precedence (Allow breaking ties, per Google's rule).
 * Crawl-delay, Sitemap, and Content-Signal are parsed but not enforced here;
 * pacing is the runner's job.
 *
 * FAIL CLOSED: a robots.txt that cannot be fetched is treated as "disallow
 * everything", never "allow everything". A harvest that silently proceeds
 * because a network blip hid the rules is the failure this guards against.
 */

export interface RobotsRule {
  /** Path pattern as written, may contain `*` and a trailing `$`. */
  pattern: string;
  allow: boolean;
}

export interface RobotsTxt {
  /** Rules for the user-agent this was parsed for, most specific group only. */
  rules: RobotsRule[];
  /** Seconds, if the matched group declared one. Advisory. */
  crawlDelay: number | null;
  /** True when a `User-agent: *` or matching group was actually found. */
  matched: boolean;
}

/**
 * Parse robots.txt for a specific user-agent.
 *
 * Group selection follows the standard: the most specific matching
 * User-agent group wins, falling back to `*`. Consecutive User-agent lines
 * share one group of rules.
 */
export function parseRobotsTxt(text: string, userAgent: string): RobotsTxt {
  const ua = userAgent.toLowerCase();

  // groupName -> rules, preserving the "consecutive User-agent lines share a
  // group" rule by tracking which agents the current group applies to.
  const groups = new Map<string, { rules: RobotsRule[]; crawlDelay: number | null }>();
  let currentAgents: string[] = [];
  // Set while reading User-agent lines; the first non-agent directive ends the
  // agent run and starts the rule body.
  let readingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      if (!readingAgents) {
        currentAgents = [];
        readingAgents = true;
      }
      currentAgents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) {
        groups.set(value.toLowerCase(), { rules: [], crawlDelay: null });
      }
      continue;
    }

    readingAgents = false;
    if (currentAgents.length === 0) continue;

    for (const agent of currentAgents) {
      const group = groups.get(agent)!;
      if (field === 'disallow') {
        // "Disallow:" with an empty value means allow everything — it is not a
        // rule matching the empty path. Skipping it is correct.
        if (value) group.rules.push({ pattern: value, allow: false });
      } else if (field === 'allow') {
        if (value) group.rules.push({ pattern: value, allow: true });
      } else if (field === 'crawl-delay') {
        const n = Number(value);
        if (Number.isFinite(n)) group.crawlDelay = n;
      }
    }
  }

  // Most specific match: the longest declared agent token that our UA contains.
  let best: string | null = null;
  for (const name of groups.keys()) {
    if (name === '*') continue;
    if (ua.includes(name) && (best === null || name.length > best.length)) best = name;
  }
  const chosen = best ?? (groups.has('*') ? '*' : null);
  if (!chosen) return { rules: [], crawlDelay: null, matched: false };

  const group = groups.get(chosen)!;
  return { rules: group.rules, crawlDelay: group.crawlDelay, matched: true };
}

/** Translate a robots path pattern into an anchored RegExp. */
function patternToRegExp(pattern: string): RegExp {
  const endAnchored = pattern.endsWith('$');
  const body = endAnchored ? pattern.slice(0, -1) : pattern;
  // Escape everything regex-significant except `*`, which robots defines as
  // "any sequence of characters".
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${endAnchored ? '$' : ''}`);
}

/**
 * Is `pathname` (path + query, as robots matches it) fetchable?
 *
 * Longest matching pattern wins; Allow wins a tie. A file with no rules at all
 * permits everything, which is what an empty robots.txt means — distinct from
 * a robots.txt that could not be fetched, which the caller must treat as a
 * refusal before ever getting here.
 */
export function isAllowed(robots: RobotsTxt, pathname: string): boolean {
  let bestLen = -1;
  let bestAllow = true;

  for (const rule of robots.rules) {
    if (!patternToRegExp(rule.pattern).test(pathname)) continue;
    // `$`-anchored patterns are as specific as their literal length.
    const len = rule.pattern.length;
    if (len > bestLen || (len === bestLen && rule.allow)) {
      bestLen = len;
      bestAllow = rule.allow;
    }
  }

  return bestLen === -1 ? true : bestAllow;
}

/** The path robots matches against: pathname plus query string. */
export function robotsPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}
