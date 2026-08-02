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

// ── Aligning rows that arrive short ──────────────────────────────────────────

/**
 * WHY THIS EXISTS — measured, not theorised.
 *
 * uniben.edu writes its fee table's last row as a merged label:
 *
 *     <td colspan="2">TOTAL</td><td>80,000.00</td><td>60,000.00</td>
 *
 * Unstructured's `text_as_html` DROPS the colspan and emits three plain cells
 * for a four-column table. Padding the gap on the right then produced
 *
 *     | TOTAL | 80,000.00 | 60,000.00 |          (under S/NO | ITEMS | MEDICAL)
 *
 * — the medical total filed under ITEMS and the other-candidates total filed
 * under MEDICAL. Asking "what is the total fee for a medical student" returned
 * 60,000 instead of 80,000: the exact corruption this module was written to
 * prevent, reintroduced by the padding meant to prevent it.
 *
 * The gap's position cannot be recovered from the short row alone. It CAN be
 * recovered from the columns: the full-width rows establish what each column
 * holds, and a cell is placed where its own shape agrees. Trailing money
 * columns then keep their money, whichever end the missing cell was at.
 */
type CellType = 'empty' | 'number' | 'text';

/** Numbers, currency and placeholders — the shapes a value column holds. */
export function classifyCell(value: string): CellType {
  const trimmed = value.trim();
  if (trimmed === '') return 'empty';
  // A dash is how a table writes "no value here"; it belongs with the column
  // it stands in for, not with prose.
  if (/^[-–—]$/.test(trimmed)) return 'empty';
  if (/^[₦$€£]?\s*[\d,]+(\.\d+)?\s*%?$/.test(trimmed)) return 'number';
  return 'text';
}

/**
 * What each column holds, learned only from rows that are already the right
 * width — the rows whose alignment is not in question.
 */
function columnTypes(rows: string[][], width: number): (CellType | null)[] {
  const types: (CellType | null)[] = Array.from({ length: width }, () => null);

  for (let col = 0; col < width; col++) {
    const counts: Record<CellType, number> = { empty: 0, number: 0, text: 0 };
    let seen = 0;
    for (const row of rows) {
      if (row.length !== width) continue;
      const type = classifyCell(row[col] ?? '');
      if (type === 'empty') continue; // says nothing about the column
      counts[type] += 1;
      seen += 1;
    }
    if (seen === 0) continue;
    types[col] = counts.number >= counts.text ? 'number' : 'text';
  }

  return types;
}

/**
 * Place a short row's cells into `width` columns, in order, leaving the gaps
 * where the cell shapes best agree with the columns.
 *
 * Ties break toward leaving the gap EARLIER, which right-aligns the row. That
 * is the summary-row convention — `TOTAL` spanning the leading label columns
 * with the figures under their own headings — and it is the safe default when
 * the column types say nothing.
 *
 * KNOWN LIMIT: two adjacent columns of the same type leave a real ambiguity
 * that no heuristic can resolve, because the information is genuinely absent
 * from the row. The tie-break above is a considered default, not a deduction.
 * The way to remove the ambiguity rather than guess it is to stop losing the
 * colspan in the first place — for URL-sourced pages the original HTML still
 * has it, and parsing tables from there instead of from Unstructured's
 * reconstruction would make this path unnecessary for the harvest corpus.
 */
export function alignRow(cells: string[], width: number, types: (CellType | null)[]): string[] {
  if (cells.length >= width) return cells.slice(0, width);
  if (cells.length === 0) return Array.from({ length: width }, () => '');

  const score = (cell: string, col: number): number => {
    const columnType = types[col];
    if (!columnType) return 0;
    return classifyCell(cell) === columnType ? 1 : 0;
  };

  const n = cells.length;
  // best[i][j] — highest score placing the first i cells within the first j
  // columns. Standard order-preserving alignment; both dimensions are tiny.
  const best: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: width + 1 }, () => Number.NEGATIVE_INFINITY),
  );
  for (let j = 0; j <= width; j++) best[0]![j] = 0;

  for (let i = 1; i <= n; i++) {
    for (let j = i; j <= width; j++) {
      const skipColumn = best[i]![j - 1]!;
      const placeHere = best[i - 1]![j - 1]! + score(cells[i - 1]!, j - 1);
      best[i]![j] = Math.max(skipColumn, placeHere);
    }
  }

  // Walk back from the last column. On a tie, PLACE rather than skip: filling
  // the rightmost columns first pushes the gaps to the left, which is the
  // right-aligned summary-row default. (Preferring the skip here would leave
  // the blanks on the right instead — left-alignment, the very behaviour that
  // put 80,000.00 under ITEMS.)
  const out = Array.from({ length: width }, () => '');
  let i = n;
  let j = width;
  while (i > 0 && j > 0) {
    // Only skip if enough columns remain for the cells still to be placed.
    const skipColumn = j - 1 >= i ? best[i]![j - 1]! : Number.NEGATIVE_INFINITY;
    const placeHere = best[i - 1]![j - 1]! + score(cells[i - 1]!, j - 1);
    if (skipColumn > placeHere) {
      j -= 1;
    } else {
      out[j - 1] = cells[i - 1]!;
      i -= 1;
      j -= 1;
    }
  }

  return out;
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

  // Header selection: an all-<th> first row is the header. Otherwise the first
  // row is promoted, which is the conventional reading of a leading row and
  // matches every table this pipeline has met. A table whose first row is data
  // therefore loses one row to the header — visibly, in the rendered table,
  // rather than by silently shifting columns.
  const headerIndex = headerFlags.findIndex(Boolean);
  const useIndex = headerIndex === -1 ? 0 : headerIndex;

  // A short header is padded on the right: header labels lead, and there is no
  // column of established types to align them against yet.
  const headerRow = grid[useIndex]!;
  const header = Array.from({ length: width }, (_, i) => headerRow[i] ?? '');

  const bodyRows = grid.filter((_, i) => i !== useIndex);
  // Learn the columns from the rows that are already the right width, then use
  // them to place the ones that are not. See alignRow.
  const types = columnTypes(bodyRows, width);
  const rows = bodyRows.map((row) => alignRow(row, width, types));

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

// ── Recovering tables from the original HTML ─────────────────────────────────

/**
 * Every `<table>` in the source, in document order.
 *
 * A nested table makes the non-greedy match close on the inner `</table>`,
 * producing an unbalanced fragment. That fragment fails parseHtmlTable and is
 * skipped, which is the outcome we want anyway — parseHtmlTable refuses nested
 * tables deliberately.
 */
export function extractTables(html: string): string[] {
  return [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map((m) => m[0]);
}

/** Words and numbers, lowercased — what two renderings of one table share. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9.,]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Dice similarity over token multisets — 1.0 when two texts contain the same
 * words the same number of times, regardless of order or markup.
 */
export function tableSimilarity(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.length === 0 || right.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const token of left) counts.set(token, (counts.get(token) ?? 0) + 1);

  let shared = 0;
  for (const token of right) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) {
      shared += 1;
      counts.set(token, remaining - 1);
    }
  }

  return (2 * shared) / (left.length + right.length);
}

/** Below this, two tables are different tables and must not be substituted. */
const TABLE_MATCH_THRESHOLD = 0.6;

/**
 * Replace extracted Table elements with the same table parsed from the
 * ORIGINAL HTML, which still has the structure Unstructured discarded.
 *
 * WHY: uniben.edu writes `<td colspan="2">TOTAL</td>`; Unstructured's
 * `text_as_html` drops the colspan and hands back three cells for a
 * four-column row. alignRow can usually infer where the gap belongs, but
 * inference is not knowledge — two adjacent money columns leave a tie no
 * heuristic can settle. The source HTML has the answer outright, and for
 * URL-harvested pages and uploaded .html we are holding it the whole time.
 *
 * Matched by content, never by position: a page whose tables Unstructured
 * merged, split, or skipped would otherwise have one table's grid stamped onto
 * another's text. Each source table is consumed at most once, and anything
 * unmatched keeps exactly the text it arrived with.
 */
export function upgradeTablesFromSource<T extends { type: string; text: string }>(
  elements: T[],
  sourceHtml: string,
): T[] {
  const candidates = extractTables(sourceHtml)
    .map((html) => ({ markdown: htmlTableToMarkdown(html), used: false }))
    .filter((c): c is { markdown: string; used: boolean } => c.markdown !== null);

  if (candidates.length === 0) return elements;

  return elements.map((element) => {
    if (element.type !== 'Table') return element;

    let best: { index: number; score: number } | null = null;
    for (const [index, candidate] of candidates.entries()) {
      if (candidate.used) continue;
      const score = tableSimilarity(element.text, candidate.markdown);
      if (!best || score > best.score) best = { index, score };
    }

    if (!best || best.score < TABLE_MATCH_THRESHOLD) return element;

    candidates[best.index]!.used = true;
    return { ...element, text: candidates[best.index]!.markdown };
  });
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
