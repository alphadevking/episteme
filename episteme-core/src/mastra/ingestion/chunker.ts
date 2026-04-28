import { MDocument } from '@mastra/rag';
import { CHUNK_CONFIG } from '../config';

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
  pageNumber: number | null = null,
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

  // Step 2 — child chunks for all parents in parallel
  const parents = (await Promise.all(
    parentRaw.map(async (raw, pi) => {
      const parentText = raw.text.trim();
      if (!parentText) return null;

      const parentId = `${docId}-P${pi}`;

      const childDoc = MDocument.fromText(parentText);
      const childRaw = await childDoc.chunk({
        strategy: 'recursive',
        maxSize: CHUNK_CONFIG.childSize,
        overlap: CHUNK_CONFIG.childOverlap,
      });

      const children: ChildChunk[] = childRaw
        .map((cr, ci) => ({ cr, ci }))
        .filter(({ cr }) => cr.text.trim().length >= CHUNK_CONFIG.minChildLength)
        .map(({ cr, ci }) => ({
          chunkId:    `${parentId}-C${ci}`,
          parentId,
          text:       cr.text.trim(),
          chunkIndex: ci,
          category,
          pageNumber,
        }));

      if (children.length === 0) return null;
      return { parentId, text: parentText, category, pageNumber, children } as ParentChunk;
    })
  )).filter((p): p is ParentChunk => p !== null);

  return parents;
}
