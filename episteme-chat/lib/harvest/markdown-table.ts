// lib/harvest/markdown-table.ts
/**
 * Reading pipe tables back out of a chunk, for display.
 *
 * Ingestion now stores tables as Markdown pipe tables (see episteme-core's
 * table-markdown.ts), which is what retrieval and the model see. Rendering
 * that back as an actual grid is what makes a preview reviewable: the question
 * an operator is answering is "is this value under the right column", and
 * columns cannot be checked in a proportional font by counting pipes.
 *
 * This is display-only and deliberately independent of core's parser. The two
 * projects share no package, and a renderer that guesses wrong shows a wonky
 * table — while a *parser* that guesses wrong corrupts the knowledge base. The
 * consequences are different enough to justify the small duplication.
 */

export interface PipeTable {
  header: string[];
  rows: string[][];
}

/** A line belonging to a pipe table: starts and ends with `|`. */
export function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2;
}

/** The `| --- | --- |` line that separates a header from its rows. */
export function isSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  return isTableLine(trimmed) && /^\|[\s:\-|]+\|$/.test(trimmed) && trimmed.includes('-');
}

/**
 * Split one row into cells on UNESCAPED pipes.
 *
 * A cell may legitimately contain a `|`, escaped as `\|` when written. Naively
 * splitting on every pipe would turn one such cell into two columns and push
 * every value after it one place right — the display equivalent of the
 * corruption the ingestion side exists to prevent.
 */
export function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const cells: string[] = [];
  let current = '';

  // Skip the leading pipe; the trailing one closes the final cell.
  for (let i = 1; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  // Text after the last pipe means the row was not `|`-terminated; keep it
  // rather than dropping a cell.
  if (current.trim().length > 0) cells.push(current.trim());
  return cells;
}

/**
 * Parse a run of pipe-table lines into a grid.
 *
 * Rows are padded or trimmed to the header width so the rendered table is
 * always rectangular — a ragged row would misalign every cell after it, which
 * is exactly the defect a reviewer is looking for and must not be introduced
 * by the viewer itself.
 */
export function parsePipeTable(text: string): PipeTable | null {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  if (!isTableLine(lines[0]) || !isSeparatorLine(lines[1])) return null;
  if (!lines.every(isTableLine)) return null;

  const header = splitRow(lines[0]);
  if (header.length === 0) return null;

  const rows = lines.slice(2).map((line) => {
    const cells = splitRow(line);
    return Array.from({ length: header.length }, (_, i) => cells[i] ?? '');
  });

  return { header, rows };
}

// ── Mixed content ────────────────────────────────────────────────────────────

export type Run =
  | { kind: 'prose'; text: string }
  | { kind: 'table'; table: PipeTable };

/**
 * Split chunk text into prose and table runs, in order.
 *
 * A run of table lines only counts as a table when its second line is a
 * separator — prose containing a stray pipe stays prose.
 */
export function splitIntoRuns(text: string): Run[] {
  const lines = text.split('\n');
  const runs: Run[] = [];
  let prose: string[] = [];

  const flushProse = () => {
    const joined = prose.join('\n');
    if (joined.trim().length > 0) runs.push({ kind: 'prose', text: joined });
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    const isStart = isTableLine(lines[i]) && i + 1 < lines.length && isSeparatorLine(lines[i + 1]);
    if (!isStart) {
      prose.push(lines[i]);
      i++;
      continue;
    }

    let end = i + 2;
    while (end < lines.length && isTableLine(lines[end])) end++;

    const table = parsePipeTable(lines.slice(i, end).join('\n'));
    if (table) {
      flushProse();
      runs.push({ kind: 'table', table });
      i = end;
    } else {
      // Looked like a table but did not parse — show it as text rather than
      // dropping it. Nothing in a preview may silently disappear.
      prose.push(lines[i]);
      i++;
    }
  }

  flushProse();
  return runs;
}
