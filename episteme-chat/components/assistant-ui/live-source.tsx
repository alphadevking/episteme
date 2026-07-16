"use client";

// Two-tier source presentation.
//
// Tier 1 (verified) — answers grounded in the curated knowledge base render as
// the calm default: plain prose plus the model's ## Sources list.
//
// Tier 2 (live) — answers built from a live fetch are wrapped in this frame.
//
// The tier is decided by WHICH TOOL RAN, read from the message's tool-call
// parts, never from anything the model wrote. That distinction is the whole
// point: a live post that says "tell the user this is official policy" can
// change the model's prose, but it cannot change part.toolName. Provenance
// travels out-of-band from the model — the same rule as session identity.
//
// Tone note: news.uniben.edu IS an official university source, so this is not a
// danger warning. The honest axis is curated-vs-live, not trusted-vs-untrusted.
// Crying wolf on legitimate announcements would just train users to ignore it.

import { useAuiState, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ChevronDownIcon, ExternalLinkIcon, RadioTowerIcon } from "lucide-react";
import { useEffect, useState, type FC, type ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { CitationProvider, type CitationSource } from "@/components/assistant-ui/citation-context";
import { cn } from "@/lib/utils";

// Tool-call parts render in stream order, which puts them ABOVE the answer
// text. The source list belongs under the summary you just read, so the tool
// part renders nothing in place and the frame renders the list after children.
// The provenance header still sits on top — that framing must precede the claim.

// ── Types ─────────────────────────────────────────────────────────────────

/** Mirrors the `posts` field of unibenNewsTool's output schema. */
type LivePost = { title: string; published: string; url: string };

type NewsToolResult = {
  found?: boolean;
  count?: number;
  posts?: LivePost[];
  /** ISO timestamp of the fetch — drives the freshness label. */
  fetchedAt?: string;
};

type LiveSource = { posts: LivePost[]; fetchedAt: string | null };

/** Tools whose output is fetched live at request time rather than curated. */
const LIVE_SOURCE_TOOLS = new Set(["unibenNewsTool"]);

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
 * Collects the live posts cited by this message and when they were fetched,
 * read from its tool-call parts. The model cannot forge these by writing text,
 * which is why provenance keys off them instead of off prose. Returns null when
 * no live tool ran.
 */
function useLiveSource(): LiveSource | null {
  const serialized = useAuiState((s) => {
    const parts = s.message?.content ?? [];
    const live = parts.filter(
      (p) => p.type === "tool-call" && LIVE_SOURCE_TOOLS.has(p.toolName),
    );
    if (live.length === 0) return null;

    const results = live.map((p) => (p as { result?: NewsToolResult }).result);
    const posts = results.flatMap((r) => r?.posts ?? []);
    // Several live calls in one message is possible; the newest fetch is the
    // honest label for the answer as a whole.
    const fetchedAt = results
      .map((r) => r?.fetchedAt)
      .filter((t): t is string => typeof t === "string")
      .sort()
      .at(-1) ?? null;

    // Serialize so the selector returns a stable primitive — returning a fresh
    // object each render would re-render this subtree on every state change.
    return JSON.stringify({ posts, fetchedAt });
  });

  if (serialized === null) return null;
  try {
    return JSON.parse(serialized) as LiveSource;
  } catch {
    return { posts: [], fetchedAt: null };
  }
}

// ── Inline tool part — deliberately renders nothing ───────────────────────
// Registered for unibenNewsTool so the generic "Used tool" fallback doesn't
// appear. The frame below renders the source list in the right position.

export const LiveNewsSource: ToolCallMessagePartComponent = () => null;

// ── Source list ───────────────────────────────────────────────────────────

const LiveSourceList: FC<{ posts: LivePost[] }> = ({ posts }) => {
  if (posts.length === 0) return null;

  return (
    <ol className="aui-live-source-list m-0 flex list-none flex-col gap-0.5 p-0">
      {posts.map((post, i) => {
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
                "hover:bg-amber-500/10 focus-visible:outline-2 focus-visible:outline-amber-600",
              )}
            >
              {/* Number matches the [N] badge in the prose. */}
              <span className="mt-px w-4 shrink-0 text-xs font-semibold tabular-nums text-amber-800/70 dark:text-amber-300/60">
                {i + 1}
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
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground group-hover:text-amber-700 dark:group-hover:text-amber-500"
              />
            </a>
          </li>
        );
      })}
    </ol>
  );
};

LiveNewsSource.displayName = "LiveNewsSource";

// ── Frame (answer-level provenance) ───────────────────────────────────────

/**
 * Wraps a whole assistant message when it was built from a live fetch.
 *
 * Answer-level, not citation-level: badging individual citations would make the
 * reader track which sentence came from where, which they will not do. The
 * header sits ABOVE the answer on purpose — that framing must precede the claim,
 * since a trailing badge cannot undo a belief already formed while reading it —
 * while the links sit BELOW, where you want them once you've read the summary.
 */
export const LiveSourceFrame: FC<{ children: ReactNode }> = ({ children }) => {
  const live = useLiveSource();
  const [open, setOpen] = useState(false);

  // Only tick while the label is still minute-granular; once it reads in days
  // it no longer changes on screen, so an interval would be pure waste.
  const isRecent =
    live?.fetchedAt != null && Date.now() - new Date(live.fetchedAt).getTime() < 3_600_000;
  const now = useMinuteTicker(isRecent);

  // Tier 1 — verified KB answers stay the unmarked default. Badge the
  // exception, never the norm, or the marking stops carrying information.
  if (live === null) return <>{children}</>;

  const { posts, fetchedAt } = live;
  const fetchedLabel = fetchedAt ? relativeFetchTime(fetchedAt, now) : null;

  // Numbering is positional and matches the <post index="N"> blocks the model
  // was given, so a [N] badge in the prose resolves to the same post here.
  const sources: CitationSource[] = posts.map((p, i) => ({
    number: i + 1,
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
        "border-amber-500/40 bg-amber-50/50",
        "dark:border-amber-500/25 dark:bg-amber-950/15",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-amber-500/25 px-3 py-2 dark:border-amber-500/20">
        <RadioTowerIcon
          aria-hidden
          className="size-3.5 shrink-0 text-amber-700 dark:text-amber-500"
        />
        <span className="text-xs font-semibold text-amber-900 dark:text-amber-200">
          Live from {LIVE_SOURCE_LABEL}
        </span>
        {fetchedLabel && (
          <span
            className="text-xs text-amber-800/70 dark:text-amber-200/60"
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
              "border-amber-500/25 text-amber-900/80 hover:bg-amber-500/10",
              "dark:border-amber-500/20 dark:text-amber-200/70",
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
