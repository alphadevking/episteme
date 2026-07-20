import { MDocument } from '@mastra/rag';
import { CHUNK_CONFIG } from '../config';
import { pageAtOffset, type PageOffsetEntry } from './document-processor';

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

  // Step 1 — parent chunks (large, for LLM context)
  const parentDoc = contentType === 'markdown'
    ? MDocument.fromMarkdown(fullText)
    : MDocument.fromText(fullText);

  const parentRaw = await parentDoc.chunk({
    strategy,
    maxSize: CHUNK_CONFIG.parentSize,
    overlap: CHUNK_CONFIG.parentOverlap,
  });

  // The chunker doesn't report each chunk's offset in fullText, and pages were
  // flattened away when the elements were joined into fullText. Recover them by
  // locating each chunk's text in order — offsets only need to be
  // non-decreasing across chunks (true even with overlap, since the window
  // always slides forward), so searching from the previous match is enough to
  // stay correctly positioned without re-finding an earlier occurrence.
  let parentSearchFrom = 0;

  // Step 2 — child chunks for all parents in parallel
  const parents = (await Promise.all(
    parentRaw.map(async (raw, pi) => {
      const parentText = raw.text.trim();
      if (!parentText) return null;

      const parentId = `${docId}-P${pi}`;

      const parentOffset = fullText.indexOf(raw.text, parentSearchFrom);
      if (parentOffset >= 0) parentSearchFrom = parentOffset;
      const parentPage = parentOffset >= 0 ? pageAtOffset(pageOffsetMap, parentOffset) : null;

      const childDoc = MDocument.fromText(parentText);
      const childRaw = await childDoc.chunk({
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
