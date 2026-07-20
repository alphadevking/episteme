"use client";

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { type FC, memo, useCallback, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatPageLabel, useCitation, withPageAnchor } from "@/components/assistant-ui/citation-context";
import { cn } from "@/lib/utils";

type MarkdownTextProps = {
  preprocess?: (text: string) => string;
};

/**
 * Rewrite the agent's `[N](cite:N)` markers to `[N](#cite-N)`.
 *
 * react-markdown sanitizes link destinations with defaultUrlTransform, which
 * allows only https/mailto/tel/xmpp/irc and relative URLs — every other scheme
 * is rewritten to an empty string. `cite:1` was therefore arriving at the link
 * renderer as href="", which slipped past the `startsWith('cite:')` badge check
 * and rendered a live <a href=""> — a link that silently reloads the chat when
 * clicked. A fragment has no colon, so the sanitizer treats it as relative and
 * passes it through untouched.
 *
 * Done here rather than in the prompt so the agent's citation contract (and the
 * evals asserting it) stay unchanged.
 */
function rewriteCiteMarkers(text: string): string {
  return text.replace(/\]\(cite:(\d+)\)/g, "](#cite-$1)");
}

/**
 * Collapse a run of adjacent citation markers to the first one:
 * `[1](cite:1)[2](cite:2)[3](cite:3)` -> `[1](cite:1)`.
 *
 * Each badge is a hover-and-click affordance, so a row of them on one claim is
 * noise rather than evidence. The model reliably stacks every post that mentions
 * a fact — asking it not to in the prompt was measured and does not work — so
 * this is enforced here where it cannot fail.
 *
 * Trade-off: the dropped markers were real corroboration, and this hides it.
 * That's acceptable because the full source list sits directly below the answer,
 * one click away; nothing becomes unreachable, it just stops shouting.
 */
function collapseStackedCitations(text: string): string {
  return text.replace(
    /(\[\d+\]\(cite:\d+\))(?:\s*\[\d+\]\(cite:\d+\))+/g,
    "$1",
  );
}

const MarkdownTextImpl = ({ preprocess }: MarkdownTextProps) => {
  const withCiteRewrite = useCallback(
    (text: string) =>
      rewriteCiteMarkers(collapseStackedCitations(preprocess ? preprocess(text) : text)),
    [preprocess],
  );

  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="aui-md"
      components={defaultComponents}
      preprocess={withCiteRewrite}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl) as FC<MarkdownTextProps>;

// ── Citation badge ────────────────────────────────────────────────────────

const badgeClass =
  "mx-0.5 inline-flex -translate-y-0.5 items-center justify-center rounded px-[5px] py-px text-[10px] font-semibold leading-none ring-1 ring-inset";

/**
 * Renders a [N] marker.
 *
 * When the message registered a source for N, the badge is the primary
 * affordance at the point of doubt: hover previews it, click opens it. That is
 * what people actually do with citations — they check the one claim they
 * question, rather than reading a source list.
 *
 * When nothing is registered the badge stays inert (no href, cursor-default)
 * rather than rendering a link that goes nowhere.
 */
const CitationBadge: FC<{ n: number; children?: React.ReactNode }> = ({ n, children }) => {
  const source = useCitation(n);

  // Every sourced answer registers its real sources via CitationProvider, so
  // a number that doesn't resolve is always a stale or hallucinated
  // reference (e.g. the model reusing a number from an earlier turn, where
  // numbering also restarts at 1). A numbered pill implies a real citation
  // backs it — showing one here would be more misleading than showing
  // nothing, so the marker is dropped rather than rendered as an inert badge.
  if (!source) return null;

  const pageLabel = formatPageLabel(source.pages);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <sup>
          <a
            href={withPageAnchor(source.url, source.pages)}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={`Source ${n}: ${source.title}${pageLabel ? `, ${pageLabel}` : ""}`}
            className={cn(
              badgeClass,
              "cursor-pointer no-underline transition-colors",
              "bg-amber-500/15 text-amber-800 ring-amber-500/30",
              "hover:bg-amber-500/30 dark:text-amber-300 dark:ring-amber-500/25",
            )}
          >
            {children}
          </a>
        </sup>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 px-3 py-2">
        <p className="font-medium leading-snug">
          {source.title}
          {pageLabel && <span className="text-background/70"> · {pageLabel}</span>}
        </p>
        <p className="mt-0.5 text-background/70">
          {source.dateLabel ? `${source.dateLabel} · ` : ""}
          {source.tier === "live" ? "Live from " : ""}
          {(() => { try { return new URL(source.url).hostname; } catch { return "source"; } })()}
        </p>
      </TooltipContent>
    </Tooltip>
  );
};

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

   return (
    <div className="aui-code-header-root mt-4 flex items-center justify-between rounded-t-lg border border-border bg-secondary/50 px-4 py-2 text-xs">
      <div className="flex items-center gap-2">
        <div className="size-2 rounded-full bg-primary/60" />
        <span className="aui-code-header-language font-mono font-medium text-muted-foreground uppercase tracking-wider">
          {language}
        </span>
      </div>
      <TooltipIconButton tooltip="Copy" onClick={onCopy} className="size-7 hover:bg-primary/10 hover:text-primary transition-colors">
        {!isCopied && <CopyIcon className="size-3.5" />}
        {isCopied && <CheckIcon className="size-3.5 text-primary" />}
      </TooltipIconButton>
    </div>
  );
};

const useCopyToClipboard = ({
  copiedDuration = 3000,
}: {
  copiedDuration?: number;
} = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    if (!value) return;

    navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };

  return { isCopied, copyToClipboard };
};

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "aui-md-h1 mb-2 scroll-m-20 font-semibold text-base first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, children, ...props }) => {
    const isSources =
      typeof children === 'string'
        ? children.trim() === 'Sources'
        : Array.isArray(children) && children.length === 1 && children[0] === 'Sources';
    return (
      <h2
        className={cn(
          "aui-md-h2 mt-3 mb-1.5 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0",
          isSources && "mt-5 border-t border-border pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground",
          className,
        )}
        {...props}
      >
        {children}
      </h2>
    );
  },
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "aui-md-h3 mt-2.5 mb-1 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        "aui-md-h4 mt-2 mb-1 scroll-m-20 font-medium text-sm first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      className={cn(
        "aui-md-h5 mt-2 mb-1 font-medium text-sm first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn(
        "aui-md-h6 mt-2 mb-1 font-medium text-sm first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
   p: ({ className, ...props }) => (
    <p
      className={cn(
        "aui-md-p my-3 leading-relaxed text-[15px] first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  a: ({ className, href, children, ...props }) => {
    // Citation marker: [N](cite:N), normalised to #cite-N by rewriteCiteMarkers.
    // `cite:` is still matched in case an unprocessed marker arrives.
    const citeMatch = href?.match(/^(?:#cite-|cite:)(\d+)$/);
    if (citeMatch) {
      return <CitationBadge n={Number(citeMatch[1])}>{children}</CitationBadge>;
    }
    return (
      <a
        className={cn(
          "aui-md-a text-primary underline underline-offset-2 hover:text-primary/80",
          className,
        )}
        href={href}
        target={href?.startsWith('http') ? '_blank' : undefined}
        rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
        {...props}
      >
        {children}
      </a>
    );
  },
   blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "aui-md-blockquote my-4 border-primary/30 border-l-3 pl-4 text-muted-foreground/90 italic bg-primary/5 py-2 rounded-r-md",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "aui-md-ul my-2 ml-4 list-disc marker:text-muted-foreground [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "aui-md-ol my-2 ml-4 list-decimal marker:text-muted-foreground [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr
      className={cn("aui-md-hr my-2 border-muted-foreground/20", className)}
      {...props}
    />
  ),
  table: ({ className, ...props }) => (
    <table
      className={cn(
        "aui-md-table my-2 w-full border-separate border-spacing-0 overflow-y-auto",
        className,
      )}
      {...props}
    />
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "aui-md-th bg-muted px-2 py-1 text-left font-medium first:rounded-tl-lg last:rounded-tr-lg [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "aui-md-td border-muted-foreground/20 border-b border-l px-2 py-1 text-left last:border-r [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-bl-lg [&:last-child>td:last-child]:rounded-br-lg",
        className,
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("aui-md-li leading-normal", className)} {...props} />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
   pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "aui-md-pre overflow-x-auto rounded-b-lg border border-border border-t-0 bg-background/50 p-4 font-mono text-xs leading-relaxed selection:bg-primary/20",
        className,
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isCodeBlock &&
            "aui-md-inline-code rounded-md border border-border/50 bg-muted/50 px-1.5 py-0.5 font-mono text-[0.85em]",
          className,
        )}
        {...props}
      />
    );
  },
  CodeHeader,
});
