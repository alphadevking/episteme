"use client";

// components/admin/preview-drawer.tsx
/**
 * Reads a previewed document before it is committed.
 *
 * A preview only earns its cost if a person can actually judge it, and the
 * question they are judging is "did extraction produce the page, or did it
 * produce the page's navigation menu?". Counts cannot answer that. Neither can
 * three chunks truncated at 600 characters — a page that starts clean and
 * collapses into boilerplate halfway down looks identical to a good one.
 *
 * So this renders every chunk core returned, verbatim, in two readings:
 *
 *   Document  the text end to end, as a person would read it. This is where a
 *             bad extraction is obvious — repeated nav labels, a footer
 *             swallowed mid-page, a table flattened into noise.
 *   Chunks    the same text split at the boundaries retrieval will use, so the
 *             reviewer can see whether an answer-bearing passage got cut in
 *             half.
 *
 * Chunk overlap is shown rather than hidden: consecutive parents deliberately
 * repeat ~200 characters, and quietly de-duplicating that seam would show a
 * document that does not exist in the index.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangleIcon,
  FileTextIcon,
  LayersIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import type { PreviewReport } from "@/lib/harvest/plan";
import { countMatches, segmentByMatches } from "@/lib/harvest/text-search";
import { splitIntoRuns } from "@/lib/harvest/markdown-table";

type View = "document" | "chunks";

/**
 * Render text with matches marked.
 *
 * Nodes, never an HTML string: the text comes from a third-party page, so
 * `dangerouslySetInnerHTML` here would turn a review tool into an injection
 * sink. The segmentation itself is tested in lib/harvest/text-search.test.ts,
 * including the property that segments always reassemble into the original.
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  const segments = segmentByMatches(text, query);
  if (segments.length === 1) return <>{segments[0].text}</>;

  return (
    <>
      {segments.map((segment) =>
        segment.match ? (
          <mark key={segment.start} className="rounded bg-amber-300/60 dark:bg-amber-400/30 text-inherit px-0.5">
            {segment.text}
          </mark>
        ) : (
          <span key={segment.start}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Render chunk text, drawing any pipe table as an actual grid.
 *
 * Ingestion stores tables as Markdown pipe tables, which is what retrieval and
 * the model see. Showing them as raw `| a | b |` lines in a proportional font
 * would leave the reviewer counting pipes to answer the one question a preview
 * is for — is this value under the right column. A real <table> answers it at
 * a glance, and the horizontal scroll keeps a wide table from breaking the
 * page rather than squeezing columns into illegibility.
 */
function ChunkBody({ text, query }: { text: string; query: string }) {
  const runs = splitIntoRuns(text);

  return (
    <div className="space-y-3">
      {runs.map((run, i) =>
        run.kind === "prose" ? (
          <p
            // Runs are positional slices of one immutable string; there is no
            // reorder for a key to survive.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
            key={i}
            className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap break-words"
          >
            <Highlighted text={run.text} query={query} />
          </p>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
          <div key={i} className="overflow-x-auto rounded-lg border">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-muted/60">
                  {run.table.header.map((cell, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: column position IS the identity
                    <th key={c} className="border-b px-3 py-2 text-left font-semibold whitespace-nowrap">
                      <Highlighted text={cell} query={query} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {run.table.rows.map((row, r) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: row position IS the identity
                  <tr key={r} className="border-b last:border-b-0 even:bg-muted/20">
                    {row.map((cell, c) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: column position IS the identity
                      <td key={c} className="px-3 py-1.5 align-top">
                        <Highlighted text={cell} query={query} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
    </div>
  );
}

function Meta({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-xs font-medium ${tone === "warn" ? "text-amber-600 dark:text-amber-400" : ""}`}>
        {value}
      </p>
    </div>
  );
}

export function PreviewDrawer({
  report,
  title,
  url,
  onClose,
}: {
  report: PreviewReport;
  /** The citation label — what a user would see under an answer. */
  title: string;
  url: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>("document");
  const [query, setQuery] = useState("");

  // Escape closes. Without it the only way out is the mouse, and this opens
  // over a run the operator may want to get back to quickly.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const matches = useMemo(
    () => countMatches(report.chunks.map((c) => c.text), query),
    [report.chunks, query],
  );
  const shownChars = useMemo(
    () => report.chunks.reduce((sum, c) => sum + c.length, 0),
    [report.chunks],
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close preview"
        onClick={onClose}
        className="absolute inset-0 bg-background/70 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${title}`}
        className="relative flex h-full w-full max-w-3xl flex-col border-l bg-card shadow-2xl"
      >
        {/* ── Header ── */}
        <div className="shrink-0 border-b px-6 py-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate">{title}</p>
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors break-all"
              >
                {url}
              </a>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <XIcon className="size-4" />
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Meta label="Namespace" value={report.namespace} />
            <Meta label="Roles" value={report.roles.join(", ")} />
            <Meta label="Extracted" value={`${report.textLength.toLocaleString()} chars`} />
            <Meta label="Vectors" value={`${report.vectorsWouldUpsert} (${report.parentChunks} parents)`} />
          </div>

          {(report.replacesExisting || report.movesFromNamespace) && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
              <AlertTriangleIcon className="size-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-snug">
                {report.replacesExisting && "Committing replaces the document already stored under this ID. "}
                {report.movesFromNamespace &&
                  `It also moves from the ${report.movesFromNamespace} namespace to ${report.namespace}, and the old vectors are deleted.`}
              </p>
            </div>
          )}

          {/* ── View switch + search ── */}
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border bg-muted/40 p-0.5">
              {([
                { id: "document" as View, icon: FileTextIcon, label: "Document" },
                { id: "chunks" as View, icon: LayersIcon, label: "Chunks" },
              ]).map(({ id, icon: Icon, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setView(id)}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                    view === id ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              ))}
            </div>

            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find in extracted text…"
                className="w-full h-8 rounded-lg border border-input bg-background pl-8 pr-3 text-xs placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>

            {query.trim() && (
              <span className="text-[11px] tabular-nums text-muted-foreground whitespace-nowrap">
                {matches} match{matches === 1 ? "" : "es"}
              </span>
            )}
          </div>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {view === "document" ? (
            <article className="space-y-6">
              {report.chunks.map((chunk, i) => (
                <div key={chunk.index} className="space-y-2">
                  {i > 0 && (
                    <div className="flex items-center gap-2 pt-1">
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                        chunk {chunk.index}
                        {chunk.pageNumber !== null && ` · page ${chunk.pageNumber}`}
                      </span>
                      <div className="flex-1 h-px bg-border" />
                    </div>
                  )}
                  <ChunkBody text={chunk.text} query={query} />
                </div>
              ))}
            </article>
          ) : (
            <div className="space-y-4">
              {report.chunks.map((chunk) => (
                <div key={chunk.index} className="rounded-lg border bg-background overflow-hidden">
                  <div className="flex items-center gap-3 border-b bg-muted/30 px-3 py-2">
                    <span className="text-[11px] font-mono font-medium">chunk {chunk.index}</span>
                    <span className="text-[11px] text-muted-foreground">{chunk.length.toLocaleString()} chars</span>
                    <span className="text-[11px] text-muted-foreground">
                      {chunk.childCount} vector{chunk.childCount === 1 ? "" : "s"}
                    </span>
                    {chunk.pageNumber !== null && (
                      <span className="text-[11px] text-muted-foreground">page {chunk.pageNumber}</span>
                    )}
                  </div>
                  <div className="px-3 py-2.5">
                    <ChunkBody text={chunk.text} query={query} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {report.chunks.length === 0 && (
            <p className="text-sm text-muted-foreground">This preview returned no chunks.</p>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="shrink-0 border-t px-6 py-3 flex items-center gap-3">
          <p className="text-[11px] text-muted-foreground flex-1">
            {report.chunksTruncated ? (
              <span className="text-amber-600 dark:text-amber-400">
                Showing {report.chunks.length} of {report.parentChunks} chunks — the rest exceeded the
                preview size limit and are not displayed. All {report.parentChunks} would be ingested.
              </span>
            ) : (
              <>
                All {report.parentChunks} chunk{report.parentChunks === 1 ? "" : "s"} shown,
                verbatim ({shownChars.toLocaleString()} chars). Consecutive chunks overlap by design,
                so text near a boundary appears twice.
              </>
            )}
          </p>
          <span className="text-[11px] font-mono text-muted-foreground whitespace-nowrap">{report.docId}</span>
        </div>
      </div>
    </div>
  );
}
