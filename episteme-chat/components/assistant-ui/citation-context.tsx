"use client";

// Citation registry.
//
// The markdown renderer only ever sees `[1](#cite-1)` — a number, no source.
// Whatever knows the real sources for a message (AnswerSourceFrame, reading
// groundedResponseTool's and unibenNewsTool's output) registers them here, and
// the badge renderer resolves N -> source without the generic markdown
// component having to import either feature.
//
// Sources are registered from tool output, never parsed out of the model's
// prose, so a citation cannot point somewhere the model merely claimed it does.

import { createContext, useContext, useMemo, type FC, type ReactNode } from "react";

export type CitationSource = {
  /** 1-based number matching the [N] marker in the prose. */
  number: number;
  title: string;
  url: string;
  /** Human-readable date, already formatted. */
  dateLabel?: string;
  /**
   * Page numbers (1-based) this source was cited from, sorted ascending. Only
   * populated for KB documents with page structure (PDFs) — empty for live
   * news posts and paginationless HTML sources.
   */
  pages?: number[];
  /**
   * Provenance tier. "live" = fetched live at request time (unibenNewsTool,
   * used as a direct query). "kb" = the curated knowledge base, or a live
   * fetch used only as a fallback when the KB had nothing — both render
   * identically, without the "live" framing. "web" = webSearchTool, the
   * public internet — not first-party Uniben content, rendered with a
   * visibly more cautious style than either of the above.
   */
  tier: "live" | "kb" | "web";
};

const CitationContext = createContext<Map<number, CitationSource> | null>(null);

export const CitationProvider: FC<{
  sources: CitationSource[];
  children: ReactNode;
}> = ({ sources, children }) => {
  const map = useMemo(
    () => new Map(sources.map((s) => [s.number, s])),
    [sources],
  );
  return <CitationContext.Provider value={map}>{children}</CitationContext.Provider>;
};

/**
 * Resolve a citation number to its source.
 * Returns null when nothing is registered — every sourced answer now registers
 * its real sources via CitationProvider, so an unresolved number means the
 * model cited a number that doesn't exist in this message's source list (e.g.
 * reused from an earlier turn, where numbering also restarts at 1).
 */
export function useCitation(n: number): CitationSource | null {
  const map = useContext(CitationContext);
  return map?.get(n) ?? null;
}

/** "p. 12" for a single page, "pp. 5, 12" for several. Null when no pages. */
export function formatPageLabel(pages?: number[]): string | null {
  if (!pages || pages.length === 0) return null;
  return pages.length === 1 ? `p. ${pages[0]}` : `pp. ${pages.join(", ")}`;
}

/**
 * Appends a `#page=N` fragment so the link opens straight to the cited page —
 * a convention browsers' built-in PDF viewers honour. Only safe to add for
 * PDF URLs; anything else (HTML pages, scraped announcements) ignores the
 * fragment or, worse, could already use it for something else.
 */
export function withPageAnchor(url: string, pages?: number[]): string {
  if (!pages || pages.length === 0) return url;
  const path = url.split(/[?#]/)[0];
  if (!/\.pdf$/i.test(path)) return url;
  return `${url}#page=${pages[0]}`;
}
