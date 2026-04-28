import { UnstructuredClient } from 'unstructured-client';
import { Strategy } from 'unstructured-client/sdk/models/shared/partitionparameters';

declare const process: { env: Record<string, string | undefined> };

export interface ProcessedElement {
  text: string;
  type: string;
  pageNumber: number | null;
  category: string;
}

const client = new UnstructuredClient({
  serverURL: 'https://api.unstructuredapp.io',
  security: { apiKeyAuth: process.env['UNSTRUCTURED_API_KEY']! },
});

/** HiRes (OCR) only for image formats — everything else uses Fast text extraction. */
function strategyFor(fileName: string): Strategy {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return ['png', 'jpg', 'jpeg', 'tiff', 'tif'].includes(ext)
    ? Strategy.HiRes
    : Strategy.Fast;
}

/**
 * Process a binary document (PDF, DOCX, HTML, scanned image) via Unstructured API.
 * Returns clean structured elements. OCR is applied automatically for scanned docs.
 * Caller is responsible for reading the file buffer.
 */
export async function processDocument(
  fileBuffer: Uint8Array,
  fileName: string,
  category: string
): Promise<ProcessedElement[]> {
  const strategy = strategyFor(fileName);
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  const isPdf = ext === 'pdf';

  const response = await client.general.partition({
    partitionParameters: {
      files: { content: fileBuffer, fileName },
      strategy,
      // splitPdfPage parallelises page processing on Unstructured's side — only worth
      // the overhead for multi-page PDFs; images and DOCX process as a single unit.
      splitPdfPage: isPdf,
      languages: ['eng'],
    },
  });

  const elements = Array.isArray(response) ? response : [];

  if (elements.length === 0) {
    throw new Error(`No elements extracted from ${fileName}`);
  }

  return elements
    .map((el: Record<string, any>) => ({
      text: (el['text'] as string) ?? '',
      type: (el['type'] as string) ?? 'Unknown',
      pageNumber: (el['metadata']?.['page_number'] as number | null) ?? null,
      category,
    }))
    .filter((el: ProcessedElement) => el.text.trim().length > 0);
}

/**
 * Process Markdown content — no API call needed.
 * Caller passes file content as a string.
 */
export function processMarkdown(content: string, category: string): ProcessedElement[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      let type = 'NarrativeText';
      if (line.startsWith('#'))              type = 'Title';
      else if (/^[-*]\s/.test(line))         type = 'ListItem';
      else if (line.startsWith('|'))         type = 'Table';
      else if (/^\d+\.\s/.test(line))        type = 'ListItem';
      return { text: line, type, pageNumber: null, category };
    });
}

/**
 * Process plain text content — for announcements, emails, general info.
 * Caller passes file content as a string.
 */
export function processPlainText(content: string, category: string): ProcessedElement[] {
  return content
    .split(/\n{2,}/) // split on blank lines (paragraph boundaries)
    .map((para) => para.replace(/\n/g, ' ').trim())
    .filter((para) => para.length > 0)
    .map((para) => ({ text: para, type: 'NarrativeText', pageNumber: null, category }));
}

/**
 * Merge all elements from a processed document into a single text string.
 * Used as input for MDocument chunking in the ingestion pipeline.
 */
export function elementsToText(elements: ProcessedElement[]): string {
  return elements.map((el) => el.text).join('\n\n');
}
