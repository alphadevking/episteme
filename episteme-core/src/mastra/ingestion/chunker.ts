import { MDocument } from '@mastra/rag';
import { CHUNK_CONFIG } from '../config';
import { pageAtOffset, type PageOffsetEntry } from './document-processor';
import { isSeparatorLine, isTableLine, parseMarkdownTable, splitMarkdownTable } from './table-markdown';

export interface ParentChunk {
  parentId: string;
  text: string;
  category: string;
  pageNumber: number | null;
  children: ChildChunk[];
}

export interface ChildChunk {
  chunkId: string;
  parentId: string;
  text: string;
  chunkIndex: number;
  category: string;
  pageNumber: number | null;
}

/**
 * Content types drive chunking strategy.
 * - policy/handbook:   recursive — respects section/paragraph structure
 * - faq/announcement: sentence  — short, self-contained units
 * - markdown:          markdown  — preserves heading hierarchy
 * - catalogue/general: recursive — safe default for mixed content
 */
export type ContentType =
  | 'policy'
  | 'handbook'
  | 'faq'
  | 'announcement'
  | 'catalogue'
  | 'markdown'
  | 'general';

// Sizes are tunable via env vars — see config.ts for defaults and rationale

function strategyFor(contentType: ContentType): 'recursive' | 'sentence' | 'markdown' {
  switch (contentType) {
    case 'faq':
    case 'announcement':
      return 'sentence';
    case 'markdown':
      return 'markdown';
    default:
      return 'recursive'; // safe for policy, handbook, catalogue, general
  }
}

/**
 * A stretch of the document that chunks by one set of rules.
 *
 * Tables need different rules from prose: prose is split on paragraph and
 * sentence boundaries, while a table must be split on ROW boundaries with its
 * header repeated, or the fragments lose their column labels.
 */
export interface TextBlock {
  kind: 'prose' | 'table';
  /** Exact substring of the source text — never trimmed, so offsets stay true. */
  text: string;
  /** Where this block starts in the source text, for page mapping. */
  offset: number;
}

/**
 * Partition text into prose and Markdown-table blocks.
 *
 * ADDITIVE BY CONSTRUCTION: a document containing no table returns exactly one
 * prose block spanning the whole input, so the chunking call made for it is
 * byte-for-byte the call that was made before tables were handled at all. The
 * new path is reachable only by documents that actually contain a table, and
 * chunker.test.ts pins that property directly.
 *
 * A run of table lines counts as a table only when its second line is a
 * separator (`| --- | --- |`). Prose that happens to contain a pipe — a code
 * sample, an ASCII diagram — is left alone.
 */
export function splitIntoBlocks(text: string): TextBlock[] {
  const lines = text.split('\n');

  // Character offset of each line in `text`.
  const lineOffsets: number[] = [];
  let running = 0;
  for (const line of lines) {
    lineOffsets.push(running);
    running += line.length + 1; // + '\n'
  }

  // Mark the [start, end) line ranges that form real tables.
  const tableRanges: { start: number; end: number }[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isTableLine(lines[i]!) && i + 1 < lines.length && isSeparatorLine(lines[i + 1]!)) {
      let end = i + 2;
      while (end < lines.length && isTableLine(lines[end]!)) end += 1;
      tableRanges.push({ start: i, end });
      i = end;
    } else {
      i += 1;
    }
  }

  if (tableRanges.length === 0) {
    return [{ kind: 'prose', text, offset: 0 }];
  }

  const blocks: TextBlock[] = [];
  let cursor = 0;

  const pushProse = (from: number, to: number) => {
    if (to <= from) return;
    const slice = text.slice(from, to);
    // Whitespace-only gaps between blocks carry no content to chunk.
    if (slice.trim().length > 0) blocks.push({ kind: 'prose', text: slice, offset: from });
  };

  for (const range of tableRanges) {
    const start = lineOffsets[range.start]!;
    const lastLine = range.end - 1;
    const end = lineOffsets[lastLine]! + lines[lastLine]!.length;

    pushProse(cursor, start);
    blocks.push({ kind: 'table', text: text.slice(start, end), offset: start });
    cursor = end;
  }

  pushProse(cursor, text.length);
  return blocks;
}

/**
 * Hierarchical chunking via Mastra's MDocument — "small-to-big retrieval" pattern.
 *
 * 1. Chunk text into large parent chunks (returned to LLM as context).
 * 2. Sub-chunk each parent into smaller child chunks (used for retrieval).
 *
 * Strategy is selected per content type so any document form is handled correctly:
 * policy docs, FAQs, announcements, course catalogues, handbooks, etc.
 */
export async function buildHierarchicalChunks(
  fullText: string,
  docId: string,
  category: string,
  contentType: ContentType = 'general',
  pageOffsetMap: PageOffsetEntry[] = [],
): Promise<ParentChunk[]> {
  const strategy = strategyFor(contentType);

  // Step 1 — parent chunks (large, for LLM context).
  //
  // Prose blocks go through exactly the call this function has always made.
  // Table blocks are split on row boundaries instead, so a table never loses
  // its header to an arbitrary character cut. A document with no tables is one
  // prose block, so its result is unchanged — see splitIntoBlocks.
  const blocks = splitIntoBlocks(fullText);
  const parentSpans: { text: string; offset: number }[] = [];

  for (const block of blocks) {
    if (block.kind === 'table') {
      for (const fragment of splitMarkdownTable(block.text, CHUNK_CONFIG.parentSize)) {
        parentSpans.push({ text: fragment, offset: block.offset });
      }
      continue;
    }

    const parentDoc = contentType === 'markdown'
      ? MDocument.fromMarkdown(block.text)
      : MDocument.fromText(block.text);

    const parentRaw = await parentDoc.chunk({
      strategy,
      maxSize: CHUNK_CONFIG.parentSize,
      overlap: CHUNK_CONFIG.parentOverlap,
    });

    // The chunker doesn't report each chunk's offset, and pages were flattened
    // away when the elements were joined into fullText. Recover them by
    // locating each chunk's text in order — offsets only need to be
    // non-decreasing across chunks (true even with overlap, since the window
    // always slides forward), so searching from the previous match is enough to
    // stay correctly positioned without re-finding an earlier occurrence.
    let searchFrom = 0;
    for (const raw of parentRaw) {
      const trimmed = raw.text.trim();
      if (!trimmed) continue;
      const relative = block.text.indexOf(raw.text, searchFrom);
      if (relative >= 0) searchFrom = relative;
      parentSpans.push({
        text: trimmed,
        offset: block.offset + (relative >= 0 ? relative : 0),
      });
    }
  }

  // Step 2 — child chunks for all parents in parallel
  const parents = (await Promise.all(
    parentSpans.map(async (span, pi) => {
      const parentText = span.text;
      if (!parentText) return null;

      const parentId = `${docId}-P${pi}`;

      const parentOffset = span.offset;
      const parentPage = pageAtOffset(pageOffsetMap, parentOffset);

      // A table parent sub-chunks by rows, header repeated, for the same
      // reason it was split that way: an embedded child that is four bare
      // numbers matches nothing useful and, if retrieved, says nothing true.
      const isTable = parseMarkdownTable(parentText) !== null;

      const childRaw = isTable
        ? splitMarkdownTable(parentText, CHUNK_CONFIG.childSize).map((text) => ({ text }))
        : await MDocument.fromText(parentText).chunk({
            strategy: 'recursive',
            maxSize: CHUNK_CONFIG.childSize,
            overlap: CHUNK_CONFIG.childOverlap,
          });

      let childSearchFrom = 0;

      const children: ChildChunk[] = childRaw
        .map((cr, ci) => ({ cr, ci }))
        .filter(({ cr }) => cr.text.trim().length >= CHUNK_CONFIG.minChildLength)
        .map(({ cr, ci }) => {
          const text = cr.text.trim();
          const childOffsetInParent = parentText.indexOf(text, childSearchFrom);
          if (childOffsetInParent >= 0) childSearchFrom = childOffsetInParent;
          const childPage = childOffsetInParent >= 0 && parentOffset >= 0
            ? pageAtOffset(pageOffsetMap, parentOffset + childOffsetInParent)
            : parentPage;

          return {
            chunkId:    `${parentId}-C${ci}`,
            parentId,
            text,
            chunkIndex: ci,
            category,
            pageNumber: childPage,
          };
        });

      if (children.length === 0) return null;
      return { parentId, text: parentText, category, pageNumber: parentPage, children } as ParentChunk;
    })
  )).filter((p): p is ParentChunk => p !== null);

  return parents;
}
