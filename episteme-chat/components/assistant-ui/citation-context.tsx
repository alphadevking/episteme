"use client";

// Citation registry.
//
// The markdown renderer only ever sees `[1](#cite-1)` — a number, no source.
// Whatever knows the real sources for a message (currently LiveSourceFrame,
// reading the news tool's output) registers them here, and the badge renderer
// resolves N -> source without the generic markdown component having to import
// the news feature.
//
// Sources are registered from tool output, never parsed out of the model's
// prose, so a citation cannot point somewhere the model merely claimed it does.
// Unregistered numbers stay inert rather than guessing.

import { createContext, useContext, useMemo, type FC, type ReactNode } from "react";

export type CitationSource = {
  /** 1-based number matching the [N] marker in the prose. */
  number: number;
  title: string;
  url: string;
  /** Human-readable date, already formatted. */
  dateLabel?: string;
  /**
   * Provenance tier. "live" = fetched live at request time (unibenNewsTool,
   * used as a direct query). "kb" = the curated knowledge base, or a live
   * fetch used only as a fallback when the KB had nothing — both render
   * identically, without the "live" framing.
   */
  tier: "live" | "kb";
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
 * Returns null when nothing is registered — the badge then renders inert, which
 * is the correct behaviour for knowledge-base answers whose source list lives in
 * the model's own ## Sources markdown rather than in tool output.
 */
export function useCitation(n: number): CitationSource | null {
  const map = useContext(CitationContext);
  return map?.get(n) ?? null;
}
