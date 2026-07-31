export type KbDocument = {
  docId: string;
  fileName: string;
  namespace: string;
  category: string;
  contentType: string;
  faculty: string;
  source: string;
  roles: string[];
  programme: string | null;
  levels: string[];
  /** Content date, or null when the source is genuinely undated (mirrors
   *  KbDocument.updatedAt in episteme-core/src/mastra/ingestion/kb-store.ts). */
  updatedAt: string | null;
  vectorsUpserted: number;
  parentChunks: number;
  childChunks: number;
  ingestedAt: string;
  markdownContent: string | null;
  plainTextContent: string | null;
};
