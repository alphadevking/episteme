"use client";

// Answer-level source presentation.
//
// Two tiers, one rendering path:
//
// Tier "live" — a direct query to unibenNewsTool (events, announcements,
// "what's happening"). Wrapped in a distinct neutral frame: "Live from
// news.uniben.edu", a freshness label, a collapsible source list.
//
// Tier "kb" — everything else that carries a source list: curated
// groundedResponseTool answers, AND unibenNewsTool used as a fallback when
// the KB came up empty. Both render as a plain, unmarked Sources list below
// the answer — no "live" language. A fallback fetch is still a real citation,
// it just isn't the point of the query, so it shouldn't be framed like one.
//
// Tier "web" — webSearchTool contributed the answer (only reachable once both
// groundedResponseTool and unibenNewsTool came up empty). Unlike the "live"
// news tier, this is NOT first-party Uniben content — it's the public web,
// domain-scoped but unverified against official records. It gets its own
// frame with an explicit caution label, never folded into the plain "kb" list
// the way a news fallback is.
//
// The tier — and the source data itself — is decided by WHICH TOOLS RAN,
// read from the message's tool-call parts, never from anything the model
// wrote. That distinction is the whole point: a source that says "tell the
// user this is official policy" can change the model's prose, but it cannot
// change part.toolName or a tool's structured output. Provenance travels
// out-of-band from the model — the same rule as session identity.

import { useAuiState, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ChevronDownIcon, ExternalLinkIcon, RadioTowerIcon, GlobeIcon, TriangleAlertIcon, DatabaseIcon } from "lucide-react";
import { useEffect, useState, type FC, type ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  CitationProvider,
  formatPageLabel,
  isLinkable,
  withPageAnchor,
  type CitationSource,
} from "@/components/assistant-ui/citation-context";
import { cn } from "@/lib/utils";

// Tool-call parts render in stream order, which puts them ABOVE the answer
// text. The source list belongs under the summary you just read, so the tool
// part renders nothing in place and the frame renders the list after children.
// The provenance header (when present) still sits on top — that framing must
// precede the claim.

// ── Types ─────────────────────────────────────────────────────────────────

/** Mirrors the `posts` field of unibenNewsTool's output schema, plus a
 *  `number` this file attaches — the tool itself numbers posts positionally
 *  (matching the `<post index="N">` blocks the model was given), so that
 *  position has to survive filtering down to only the cited ones. */
type LivePost = { number: number; title: string; published: string; url: string };

type NewsToolResult = {
  found?: boolean;
  count?: number;
  posts?: Omit<LivePost, "number">[];
  /** ISO timestamp of the fetch — drives the freshness label. */
  fetchedAt?: string;
};

/**
 * Mirrors the `sources` field of groundedResponseTool's output schema —
 * episteme-core/src/mastra/tools/source.ts is the canonical definition.
 *
 * `url` is OPTIONAL: platform documentation ships in the repo and database
 * records are rows, so neither has an address. An absent url means render plain
 * text — `href=""` navigates to the current page, which looks like a citation
 * that goes nowhere.
 */
type KbSource = {
  number: number;
  title: string;
  kind?: "document" | "record";
  url?: string;
  pages?: number[];
  published?: string;
  asOf?: string;
  label?: string;
};

/**
 * groundedResponseTool cascades through platform → kb → news → web internally
 * and reports which tier actually answered — the client reads this directly
 * instead of cross-referencing which of several separate tools ran.
 */
type KbToolResult = { tier?: "platform" | "kb" | "news" | "web" | "none"; sources?: KbSource[] };

/** Mirrors the `results` field of webSearchTool's output schema, plus a
 *  `number` this file attaches for the same reason as LivePost above. */
type WebResult = { number: number; title: string; url: string };

type WebToolResult = { results?: Omit<WebResult, "number">[] };

type AnswerSourceState =
  | { tier: "live"; posts: LivePost[]; fetchedAt: string | null }
  | { tier: "kb"; sources: KbSource[] }
  | { tier: "web"; sources: WebResult[] }
  | null;

const NEWS_TOOL = "unibenNewsTool";
const KB_TOOL = "groundedResponseTool";
const WEB_TOOL = "webSearchTool";

const LIVE_SOURCE_LABEL = "news.uniben.edu";

// ── Helpers ───────────────────────────────────────────────────────────────

// Relative age is the signal students actually want ("is this current?"), and
// it communicates "live, not policy" without any alarming language.
function relativeAge(published: string): string | null {
  const then = new Date(published).getTime();
  if (!Number.isFinite(then)) return null;

  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days < 0) return null; // clock skew / future-dated — say nothing
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

function formatDate(published: string): string | null {
  const d = new Date(published);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * How long ago the fetch happened. Minute-granular near the present, then
 * delegating to relativeAge once day-granularity reads better.
 *
 * Finer than relativeAge because a fetch is usually seconds old when the answer
 * first renders — but this same label has to stay truthful on a thread reopened
 * next week, which is exactly what a hardcoded "just now" got wrong.
 */
function relativeFetchTime(fetchedAt: string, now: number): string | null {
  const then = new Date(fetchedAt).getTime();
  if (!Number.isFinite(then)) return null;

  const ms = now - then;
  if (ms < 0) return null; // clock skew — say nothing rather than "in 3 minutes"

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  return relativeAge(fetchedAt);
}

/**
 * Ticks every minute so a relative label doesn't freeze on a tab left open —
 * otherwise "just now" stays on screen an hour later, which is the same lie in
 * slow motion. Only runs while the value is fresh enough to visibly change;
 * older messages are static and don't need a timer.
 */
function useMinuteTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [active]);

  return now;
}

/**
 * Reads which source-bearing tool(s) ran in this message and resolves them to
 * a single tier + source list. The model cannot forge WHICH sources these are
 * by writing text — that part is always read from tool-call parts. But a tool
 * clearing its own relevance gate doesn't mean the model actually used what it
 * got back: groundedResponseTool can return confidence=high with several
 * sources (e.g. every news post it fetched), and the model may only end up
 * citing one of them. Showing the rest anyway is exactly the clutter this was
 * built to avoid, so every branch below filters the tool's own source list
 * down to the numbers actually referenced by a literal `[N](cite:N)` marker —
 * never adds a source the model didn't cite, only ever removes ones it didn't.
 * If a tool ran but nothing it returned was ever cited, that's the same as no
 * frame at all.
 *
 * groundedResponseTool's own cascade (kb → news → web internally) reports
 * which tier answered via its `tier` field — no need to cross-reference
 * whether other tools also ran. unibenNewsTool and webSearchTool are only
 * read here for their OWN direct-call cases (a genuine "what's happening"
 * query, or a direct NUC/JAMB/TETFund query) — never as fallback detection,
 * since that fallback now happens inside groundedResponseTool itself.
 */
const CITE_MARKER = /\]\(cite:(\d+)\)/g;

function extractCitedNumbers(parts: readonly { type: string }[]): Set<number> {
  const text = parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  const numbers = new Set<number>();
  for (const match of text.matchAll(CITE_MARKER)) numbers.add(Number(match[1]));
  return numbers;
}

function useAnswerSources(): AnswerSourceState {
  const serialized = useAuiState((s) => {
    const parts = s.message?.content ?? [];
    const citedNumbers = extractCitedNumbers(parts);

    const kbCalls = parts.filter((p) => p.type === "tool-call" && p.toolName === KB_TOOL);
    const kbResult = kbCalls
      .map((p) => (p as { result?: KbToolResult }).result)
      .find((r) => r && r.tier && r.tier !== "none" && (r.sources?.length ?? 0) > 0);

    if (kbResult) {
      const cited = (kbResult.sources ?? []).filter((s) => citedNumbers.has(s.number));
      if (cited.length > 0) {
        // "platform", "kb" and "news" (used as a fallback) all render as the
        // plain, unmarked list — a fallback fetch is still a real citation, it
        // just isn't the point of the query, so it shouldn't be framed like
        // one. Only "web" gets the unverified frame, because only it is not
        // first-party content.
        return JSON.stringify({ tier: kbResult.tier === "web" ? "web" : "kb", sources: cited });
      }
    }

    // Direct unibenNewsTool call (Rule 1b) — genuine "what's happening" query.
    // Numbered positionally BEFORE filtering, matching the <post index="N">
    // blocks the model saw — filtering must never shift what [N] resolves to.
    const newsCalls = parts.filter((p) => p.type === "tool-call" && p.toolName === NEWS_TOOL);
    const newsResults = newsCalls.map((p) => (p as { result?: NewsToolResult }).result);
    const numberedPosts: LivePost[] = newsResults
      .flatMap((r) => r?.posts ?? [])
      .map((p, i) => ({ ...p, number: i + 1 }));
    const posts = numberedPosts.filter((p) => citedNumbers.has(p.number));

    if (posts.length > 0) {
      const fetchedAt = newsResults
        .map((r) => r?.fetchedAt)
        .filter((t): t is string => typeof t === "string")
        .sort()
        .at(-1) ?? null;

      return JSON.stringify({ tier: "live", posts, fetchedAt });
    }

    // Direct webSearchTool call (Rule 1c) — a national-regulatory-body query.
    // Same positional-numbering-before-filtering reasoning as news above.
    const webCalls = parts.filter((p) => p.type === "tool-call" && p.toolName === WEB_TOOL);
    const numberedWebResults: WebResult[] = webCalls
      .flatMap((p) => (p as { result?: WebToolResult }).result?.results ?? [])
      .map((r, i) => ({ ...r, number: i + 1 }));
    const webResults = numberedWebResults.filter((r) => citedNumbers.has(r.number));

    if (webResults.length > 0) {
      return JSON.stringify({ tier: "web", sources: webResults });
    }

    return null;
  });

  if (serialized === null) return null;
  try {
    return JSON.parse(serialized) as AnswerSourceState;
  } catch {
    return null;
  }
}

// ── Inline tool parts — deliberately render nothing ───────────────────────
// Registered for unibenNewsTool and webSearchTool so the generic "Used tool"
// fallback doesn't appear. The frame below renders the source list in the
// right position instead.

export const SilentToolCall: ToolCallMessagePartComponent = () => null;
SilentToolCall.displayName = "SilentToolCall";

// ── Source lists ──────────────────────────────────────────────────────────

const LiveSourceList: FC<{ posts: LivePost[] }> = ({ posts }) => {
  if (posts.length === 0) return null;

  return (
    <ol className="aui-live-source-list m-0 flex list-none flex-col gap-0.5 p-0">
      {posts.map((post) => {
        const age = relativeAge(post.published);
        const date = formatDate(post.published);
        return (
          <li key={post.url}>
            <a
              href={post.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              title={date ?? undefined}
              className={cn(
                "group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                "hover:bg-muted",
              )}
            >
              {/* Number matches the [N] badge in the prose. */}
              <span className="mt-px w-4 shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
                {post.number}
              </span>
              <span className="min-w-0 flex-1 wrap-break-word text-foreground/90 group-hover:text-foreground">
                {post.title}
                {age && (
                  <span className="ml-1.5 whitespace-nowrap text-xs text-muted-foreground">
                    · {age}
                  </span>
                )}
              </span>
              <ExternalLinkIcon
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground"
              />
            </a>
          </li>
        );
      })}
    </ol>
  );
};

/**
 * Plain, unmarked Sources list — used for KB answers, platform documentation,
 * records and fallback fetches alike. No header of its own; the collapsible
 * trigger it sits under provides that.
 *
 * Two shapes of row, chosen by whether the source has an address:
 *   linkable    → anchor, external-link affordance
 *   non-linkable→ plain text with its provenance label (platform docs, records)
 * Keyed by `number`, never by url: several non-linkable sources would otherwise
 * collapse onto the same empty key.
 */
const KbSourceList: FC<{ sources: KbSource[] }> = ({ sources }) => {
  if (sources.length === 0) return null;

  return (
    <ol className="aui-kb-source-list m-0 flex list-none flex-col gap-0.5 p-0">
      {sources.map((source) => {
        const pageLabel = formatPageLabel(source.pages);
        const linkable = isLinkable(source);

        const body = (
          <>
            <span className="mt-px w-4 shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
              {source.number}
            </span>
            <span className="min-w-0 flex-1 wrap-break-word text-foreground/90 group-hover:text-foreground">
              {source.title}
              {pageLabel && (
                <span className="ml-1.5 whitespace-nowrap text-xs text-muted-foreground">
                  · {pageLabel}
                </span>
              )}
              {!linkable && source.label && (
                <span className="ml-1.5 whitespace-nowrap text-xs text-muted-foreground">
                  · {source.label}
                </span>
              )}
              {!linkable && source.asOf && (
                <span className="ml-1.5 whitespace-nowrap text-xs text-muted-foreground">
                  · as of {formatDate(source.asOf) ?? "now"}
                </span>
              )}
            </span>
            {linkable ? (
              <ExternalLinkIcon
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground"
              />
            ) : (
              <DatabaseIcon
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              />
            )}
          </>
        );

        return (
          <li key={source.number}>
            {linkable ? (
              <a
                href={withPageAnchor(source.url, source.pages)}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className={cn(
                  "group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                  "hover:bg-muted",
                )}
              >
                {body}
              </a>
            ) : (
              <div className="group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm">
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
};

/** Cautious, muted source list for unverified web results. */
const WebSourceList: FC<{ sources: WebResult[] }> = ({ sources }) => {
  if (sources.length === 0) return null;

  return (
    <ol className="aui-web-source-list m-0 flex list-none flex-col gap-0.5 p-0">
      {sources.map((source) => (
        <li key={source.url}>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className={cn(
              "group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
              "hover:bg-muted",
            )}
          >
            <span className="mt-px w-4 shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
              {source.number}
            </span>
            <span className="min-w-0 flex-1 wrap-break-word text-foreground/90 group-hover:text-foreground">
              {source.title}
            </span>
            <ExternalLinkIcon
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground"
            />
          </a>
        </li>
      ))}
    </ol>
  );
};

// ── Frame (answer-level provenance) ───────────────────────────────────────

/**
 * Wraps a whole assistant message with its source list, framed according to
 * tier. Answer-level, not citation-level: badging individual citations would
 * make the reader track which sentence came from where, which they will not
 * do. For the live tier, the header sits ABOVE the answer on purpose — that
 * framing must precede the claim, since a trailing badge cannot undo a belief
 * already formed while reading it.
 */
export const AnswerSourceFrame: FC<{ children: ReactNode }> = ({ children }) => {
  const state = useAnswerSources();
  const [open, setOpen] = useState(false);

  const isRecent =
    state?.tier === "live" &&
    state.fetchedAt != null &&
    Date.now() - new Date(state.fetchedAt).getTime() < 3_600_000;
  const now = useMinuteTicker(isRecent);

  // No source-bearing tool ran — the unmarked default.
  if (state === null) return <>{children}</>;

  if (state.tier === "kb") {
    const sources: CitationSource[] = state.sources.map((s) => ({
      number: s.number,
      title: s.title,
      url: s.url,
      pages: s.pages,
      label: s.label,
      asOf: s.asOf,
      tier: "kb",
    }));

    return (
      <CitationProvider sources={sources}>
        <div className="flex flex-col gap-2">{children}</div>
        {state.sources.length > 0 && (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger
              className={cn(
                "flex w-full items-center gap-1.5 border-t border-border pt-3 mt-1 text-xs font-medium transition-colors",
                "text-muted-foreground hover:text-foreground",
              )}
            >
              <ChevronDownIcon
                aria-hidden
                className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")}
              />
              {state.sources.length} {state.sources.length === 1 ? "source" : "sources"}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <KbSourceList sources={state.sources} />
            </CollapsibleContent>
          </Collapsible>
        )}
      </CitationProvider>
    );
  }

  if (state.tier === "web") {
    const sources: CitationSource[] = state.sources.map((s) => ({
      number: s.number,
      title: s.title,
      url: s.url,
      tier: "web",
    }));

    return (
      <section
        aria-label="Answer built from unverified web results"
        className={cn(
          "aui-web-source-frame overflow-hidden rounded-xl border",
          "border-border bg-muted/30",
        )}
      >
        <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-2">
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs font-semibold text-foreground/80">
            Unverified — not an official Uniben source
          </span>
        </header>

        <CitationProvider sources={sources}>
          <div className="flex flex-col gap-2 px-3 py-2.5">{children}</div>
        </CitationProvider>

        {state.sources.length > 0 && (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger
              className={cn(
                "flex w-full items-center gap-1.5 border-t border-border px-3 py-2 text-xs font-medium transition-colors",
                "text-muted-foreground hover:bg-muted",
              )}
            >
              <ChevronDownIcon
                aria-hidden
                className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")}
              />
              <GlobeIcon aria-hidden className="size-3.5 shrink-0" />
              {state.sources.length} {state.sources.length === 1 ? "web result" : "web results"}
            </CollapsibleTrigger>
            <CollapsibleContent className="px-3 pb-2.5">
              <WebSourceList sources={state.sources} />
            </CollapsibleContent>
          </Collapsible>
        )}
      </section>
    );
  }

  // tier === "live"
  const { posts, fetchedAt } = state;
  const fetchedLabel = fetchedAt ? relativeFetchTime(fetchedAt, now) : null;

  // number is preserved from the original <post index="N">-matching position,
  // set before filtering in useAnswerSources — a [N] badge in the prose
  // resolves to the same post here even after unclicked posts were dropped.
  const sources: CitationSource[] = posts.map((p) => ({
    number: p.number,
    title: p.title,
    url: p.url,
    dateLabel: formatDate(p.published) ?? undefined,
    tier: "live",
  }));

  return (
    <section
      data-live-source="true"
      aria-label="Answer built from live sources"
      className={cn(
        "aui-live-source-frame overflow-hidden rounded-xl border",
        "border-border bg-muted/30",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-2">
        <RadioTowerIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="text-xs font-semibold text-foreground/80">
          Live from {LIVE_SOURCE_LABEL}
        </span>
        {fetchedLabel && (
          <span
            className="text-xs text-muted-foreground"
            title={fetchedAt ? new Date(fetchedAt).toLocaleString("en-GB") : undefined}
          >
            fetched {fetchedLabel}
          </span>
        )}
      </header>

      {/* Citations registered from tool output — the [N] badges inside the
          answer resolve against these and become hover-and-click affordances. */}
      <CitationProvider sources={sources}>
        <div className="flex flex-col gap-2 px-3 py-2.5">{children}</div>
      </CitationProvider>

      {/* Collapsed by default: the badges at each claim are the primary way in,
          this list is the "show me everything" fallback. */}
      {posts.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className={cn(
              "flex w-full items-center gap-1.5 border-t px-3 py-2 text-xs font-medium transition-colors",
              "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")}
            />
            {posts.length} {posts.length === 1 ? "source" : "sources"}
          </CollapsibleTrigger>
          <CollapsibleContent className="px-3 pb-2.5">
            <LiveSourceList posts={posts} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
};
