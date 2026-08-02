// lib/harvest/text-search.ts
/**
 * Find-in-text for the preview reader.
 *
 * Split out of the component because this is the part that can be wrong: an
 * off-by-one drops a character from a highlight, and an empty or
 * zero-advancing needle turns `indexOf` in a loop into a hung tab. Neither is
 * visible in a rendered component test, and both are trivial to pin here.
 *
 * Returns ranges rather than markup. The text comes from a third-party page,
 * so building an HTML string out of it for `dangerouslySetInnerHTML` would
 * turn a review tool into an injection sink; the caller renders the ranges as
 * React nodes instead.
 */

export interface MatchRange {
  /** Index of the first character of the match. */
  start: number;
  /** Index one past the last character. `text.slice(start, end)` is the match. */
  end: number;
}

/**
 * Every case-insensitive occurrence of `query` in `text`, in order.
 *
 * Matches do not overlap: search resumes after the end of the previous match,
 * so "aa" in "aaa" is one match, not two. That is what a reader scanning
 * highlights expects, and it is also what makes the loop terminate.
 */
export function findMatches(text: string, query: string): MatchRange[] {
  const needle = query.trim().toLowerCase();
  // An empty needle matches at every position; advancing by its length would
  // never move the cursor.
  if (!needle) return [];

  const haystack = text.toLowerCase();
  const ranges: MatchRange[] = [];

  let cursor = 0;
  let found = haystack.indexOf(needle, cursor);
  while (found !== -1) {
    ranges.push({ start: found, end: found + needle.length });
    cursor = found + needle.length;
    found = haystack.indexOf(needle, cursor);
  }

  return ranges;
}

/** Total matches across many texts — the "N matches" counter in the header. */
export function countMatches(texts: string[], query: string): number {
  return texts.reduce((total, text) => total + findMatches(text, query).length, 0);
}

/**
 * Split `text` into alternating plain and matched segments, in order.
 *
 * Concatenating every `text` reproduces the input exactly — the property that
 * matters, since a reviewer is judging the extracted content and must not be
 * shown a version of it that the highlighter quietly altered.
 */
export interface Segment {
  text: string;
  match: boolean;
  /**
   * Offset of this segment in the source text.
   *
   * Carried so the renderer has a real key. Offsets are unique within a text
   * and stay attached to the same content when the query changes, which an
   * array index does not.
   */
  start: number;
}

export function segmentByMatches(text: string, query: string): Segment[] {
  const ranges = findMatches(text, query);
  if (ranges.length === 0) return [{ text, match: false, start: 0 }];

  const segments: Segment[] = [];
  let cursor = 0;

  for (const { start, end } of ranges) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false, start: cursor });
    segments.push({ text: text.slice(start, end), match: true, start });
    cursor = end;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false, start: cursor });
  return segments;
}
