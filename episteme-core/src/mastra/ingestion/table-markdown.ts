// episteme-core/src/mastra/ingestion/table-markdown.ts
/**
 * Tables, kept as tables.
 *
 * WHAT WAS WRONG: Unstructured returns a Table element with two
 * representations — `text`, which is every cell joined by spaces, and
 * `metadata.text_as_html`, which is the reconstructed grid. The pipeline read
 * `text` and dropped the rest, so a fee table arrived as:
 *
 *   S/NO ITEMS COLLEGE OF MEDICAL SCIENCES (₦) OTHER (₦) 1 Bank/Portal
 *   Charges 5,000.00 5,000.00 2 Admission Clearance 30,000.00 30,000.00 …
 *
 * Every value is present and in row-major order, so a careful reader can
 * rebuild the grid — but only by counting, and only while the header is still
 * in view. Once a chunk boundary separates the header from the rows, four
 * numbers in a row have no columns at all, and the model assigns them by
 * guessing. That is how a medical student's fee gets quoted to everyone else.
 *
 * A Markdown pipe table fixes all three problems at once:
 *   - every row restates its own column count, so a lost header degrades to
 *     "unlabelled columns" rather than "unaligned values"
 *   - it is line-structured, so the recursive splitter has real break points
 *     instead of cutting a 400-character single line mid-number
 *   - it costs nothing extra: text_as_html is already in the response we pay for
 *
 * Scope: Unstructured's own table HTML — a flat <table> of <tr>/<th>/<td>,
 * optionally wrapped in <thead>/<tbody>, with colspan/rowspan. Nested tables
 * are not supported and return null, which makes the caller fall back to the
 * flattened text rather than emit a mangled grid.
 */

export interface HtmlTable {
  /** Column labels. Never empty when a table is returned. */
  header: string[];
  /** Body rows, every one padded to `header.length`. */
  rows: string[][];
}

// ── HTML → cells ─────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
};

/**
 * Decode the entities that appear in extracted table cells.
 *
 * Numeric forms matter more than the named ones here: the naira sign arrives
 * as `&#8358;`/`&#x20A6;` far more often than as a literal ₦, and a fee table
 * that renders "8358;80,000.00" is worse than useless.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    // Named entities last: decoding &amp; first would turn "&amp;#60;" into "<".
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Strip markup from one cell and flatten it to a single line. */
function cellText(inner: string): string {
  const withBreaks = inner
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|tr)>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(withBreaks).replace(/\s+/g, ' ').trim();
}

function attrNumber(attrs: string, name: string): number {
  const match = new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, 'i').exec(attrs);
  if (!match) return 1;
  const value = Number.parseInt(match[1]!, 10);
  // A span of 0 is legal HTML meaning "to the end of the section"; treating it
  // as 1 keeps the grid rectangular instead of unbounded.
  if (!Number.isFinite(value) || value < 1) return 1;
  // Bound it: a corrupt colspan="9999" would otherwise allocate a row of 9999
  // empty cells and bury the real values.
  return Math.min(value, 64);
}

interface RawCell {
  value: string;
  colspan: number;
  rowspan: number;
  isHeader: boolean;
}

const TABLE_RE = /<table\b[^>]*>([\s\S]*?)<\/table>/i;
const ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL_RE = /<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

/**
 * Parse Unstructured's table HTML into a rectangular grid.
 *
 * Spans are expanded rather than ignored. A cell spanning two columns is
 * repeated into both, because that is what it means — the value applies to
 * each — and because dropping the extra column would shift every value after
 * it one place left, which is the exact corruption this module exists to
 * prevent.
 */
export function parseHtmlTable(html: string): HtmlTable | null {
  const table = TABLE_RE.exec(html);
  if (!table) return null;

  const body = table[1]!;
  // A nested table would make the row regex interleave two grids. Refuse and
  // let the caller fall back to flattened text — wrong-but-honest beats a
  // confidently misaligned grid.
  if (/<table\b/i.test(body)) return null;

  const rawRows: RawCell[][] = [];
  ROW_RE.lastIndex = 0;
  for (const row of body.matchAll(ROW_RE)) {
    const cells: RawCell[] = [];
    CELL_RE.lastIndex = 0;
    for (const cell of row[1]!.matchAll(CELL_RE)) {
      cells.push({
        value: cellText(cell[3]!),
        colspan: attrNumber(cell[2]!, 'colspan'),
        rowspan: attrNumber(cell[2]!, 'rowspan'),
        isHeader: cell[1]!.toLowerCase() === 'th',
      });
    }
    if (cells.length > 0) rawRows.push(cells);
  }

  if (rawRows.length === 0) return null;

  // Expand spans into a dense grid. `carried` holds values still descending
  // from a rowspan above, keyed by the column they occupy.
  const grid: string[][] = [];
  const headerFlags: boolean[] = [];
  const carried = new Map<number, { value: string; remaining: number }>();

  for (const cells of rawRows) {
    const line: string[] = [];
    let rowIsHeader = cells.length > 0 && cells.every((c) => c.isHeader);
    let col = 0;

    const placeCarried = () => {
      let pending = carried.get(col);
      while (pending) {
        line[col] = pending.value;
        pending.remaining -= 1;
        if (pending.remaining <= 0) carried.delete(col);
        col += 1;
        pending = carried.get(col);
      }
    };

    for (const cell of cells) {
      placeCarried();
      for (let i = 0; i < cell.colspan; i++) {
        line[col] = cell.value;
        if (cell.rowspan > 1) {
          carried.set(col, { value: cell.value, remaining: cell.rowspan - 1 });
        }
        col += 1;
      }
    }
    placeCarried();

    // A row made only of carried values is a continuation, not a header.
    if (cells.length === 0) rowIsHeader = false;

    grid.push(line);
    headerFlags.push(rowIsHeader);
  }

  const width = Math.max(...grid.map((r) => r.length));
  if (width === 0) return null;

  const rectangular = grid.map((row) => {
    const filled = Array.from({ length: width }, (_, i) => row[i] ?? '');
    return filled;
  });

  // Header selection: an all-<th> first row is the header. Otherwise the first
  // row is promoted, which is the conventional reading of a leading row and
  // matches every table this pipeline has met. A table whose first row is data
  // therefore loses one row to the header — visibly, in the rendered table,
  // rather than by silently shifting columns.
  const headerIndex = headerFlags.findIndex(Boolean);
  const useIndex = headerIndex === -1 ? 0 : headerIndex;

  const header = rectangular[useIndex]!;
  const rows = rectangular.filter((_, i) => i !== useIndex);

  // A header of entirely empty labels is worse than none — it produces
  // `| | | |`, which reads as a broken table. Number the columns instead.
  const labelled = header.map((label, i) => (label.trim() ? label : `Column ${i + 1}`));

  return { header: labelled, rows };
}

// ── Cells → Markdown ─────────────────────────────────────────────────────────

/** Escape a cell so it cannot forge a column boundary. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function toRow(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

export function toMarkdownTable(table: HtmlTable): string {
  const lines = [
    toRow(table.header),
    `| ${table.header.map(() => '---').join(' | ')} |`,
    ...table.rows.map(toRow),
  ];
  return lines.join('\n');
}

/**
 * Unstructured table HTML to a Markdown pipe table.
 *
 * Returns null when the HTML yields nothing usable, so the caller can fall
 * back to the element's flattened text. Failing to a worse-but-complete
 * representation is always preferable to failing to an empty one.
 */
export function htmlTableToMarkdown(html: string): string | null {
  const table = parseHtmlTable(html);
  if (!table) return null;
  if (table.rows.length === 0) return null;
  return toMarkdownTable(table);
}

// ── Markdown table structure ─────────────────────────────────────────────────

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

export interface MarkdownTable {
  header: string;
  separator: string;
  rows: string[];
}

/**
 * Read back a pipe table produced by this module.
 *
 * Requires a separator on the second line — that is what distinguishes a table
 * from an unlucky run of prose lines that happen to start with a pipe.
 */
export function parseMarkdownTable(text: string): MarkdownTable | null {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  if (!isTableLine(lines[0]!) || !isSeparatorLine(lines[1]!)) return null;
  if (!lines.every(isTableLine)) return null;
  return { header: lines[0]!, separator: lines[1]!, rows: lines.slice(2) };
}

/**
 * Split a Markdown table into fragments of at most `maxChars`, REPEATING the
 * header and separator in each.
 *
 * This is the whole point of the exercise. A 60-row course catalogue cannot
 * fit one chunk, and without repeating the header every fragment after the
 * first is a wall of unlabelled values — course code, title, units and
 * prerequisites with nothing saying which is which.
 *
 * A single row longer than the budget is emitted whole rather than cut: a
 * truncated row is a wrong row, and half a fee is not a smaller fee.
 */
export function splitMarkdownTable(text: string, maxChars: number): string[] {
  const table = parseMarkdownTable(text);
  if (!table) return [text];

  const preamble = `${table.header}\n${table.separator}`;
  const fragments: string[] = [];
  let current: string[] = [];
  let size = preamble.length;

  for (const row of table.rows) {
    const cost = row.length + 1; // + '\n'
    if (current.length > 0 && size + cost > maxChars) {
      fragments.push([preamble, ...current].join('\n'));
      current = [];
      size = preamble.length;
    }
    current.push(row);
    size += cost;
  }

  if (current.length > 0) fragments.push([preamble, ...current].join('\n'));
  // A header-only table still has to come back as something.
  return fragments.length > 0 ? fragments : [preamble];
}
