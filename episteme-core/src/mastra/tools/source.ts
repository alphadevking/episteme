// episteme-core/src/mastra/tools/source.ts
/**
 * The citation shape every source-bearing tool returns.
 *
 * Shared so the tiers cannot drift: the client renders its source list from
 * this structure and never from the model's prose, so a change here that only
 * lands in one tool produces a source the UI cannot render — silently, at the
 * bottom of an answer nobody re-reads.
 *
 * ── Why `kind` exists ────────────────────────────────────────────────────────
 * The original shape assumed every source is a web document: it required a
 * `url` and carried `pages`. Two later tiers break that assumption:
 *
 *   - platform documentation ships in the repo and has no public URL;
 *   - database records have no URL, no pages, and no document at all — their
 *     provenance is "the institution's own records, read at time T".
 *
 * Rendering either as `<a href="">` produces a link that silently reloads the
 * page, and keying a list by URL collapses them all onto one key. So linkability
 * is now explicit (`url` optional) and provenance is explicit (`kind`), rather
 * than inferred from a field that happens to be empty.
 */
import { z } from 'zod';

/**
 * What a citation points at.
 *   document — an ingested document or page. Usually linkable.
 *   record   — rows from the institution's database. Never linkable; carries
 *              `asOf` because a record is only true as of when it was read.
 */
export type SourceKind = 'document' | 'record';

export interface Source {
  /** 1-based, matching the [N](cite:N) marker in the prose. */
  number: number;
  title: string;
  kind: SourceKind;
  /**
   * Absent or empty means NOT LINKABLE — the client must render plain text.
   * Repo-shipped platform docs and all records fall here.
   */
  url?: string;
  /** Page numbers this source was cited from. Documents with pagination only. */
  pages?: number[];
  /** ISO publication date. News posts only. */
  published?: string;
  /** ISO timestamp the data was read. Records only — a record has no edition. */
  asOf?: string;
  /**
   * Human-readable provenance for a non-linkable source, e.g. "Institution
   * academic calendar". Must never contain an identifier: this is rendered to
   * the end user, so a UUID here is the same class of leak as quoting session
   * context back at them.
   */
  label?: string;
}

/** Tool-output schema. Optional fields stay optional so each tier sends only
 *  what it genuinely has, rather than padding with empty strings. */
export const sourceSchema = z.object({
  number:    z.number().int(),
  title:     z.string(),
  kind:      z.enum(['document', 'record']),
  url:       z.string().optional(),
  pages:     z.array(z.number().int()).optional(),
  published: z.string().optional(),
  asOf:      z.string().optional(),
  label:     z.string().optional(),
});

/** A linkable ingested document or page. */
export function documentSource(input: {
  number: number;
  title: string;
  url?: string;
  pages?: number[];
  published?: string;
  label?: string;
}): Source {
  return { kind: 'document', ...input };
}

/**
 * A database-backed source.
 *
 * `asOf` defaults to now because that is the only honest value: unlike a
 * document, a record has no edition date, and the answer is true only as of the
 * moment the row was read.
 */
export function recordSource(input: {
  number: number;
  title: string;
  label: string;
  asOf?: string;
}): Source {
  return {
    kind: 'record',
    asOf: new Date().toISOString(),
    ...input,
  };
}
