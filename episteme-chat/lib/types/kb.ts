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
  level: string | null;
  updatedAt: string;
  vectorsUpserted: number;
  parentChunks: number;
  childChunks: number;
  ingestedAt: string;
  markdownContent: string | null;
  plainTextContent: string | null;
};
