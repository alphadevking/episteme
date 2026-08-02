// episteme-core/src/mastra/ingestion/table-markdown.test.ts
/**
 * The fixture is the real thing: uniben.edu's acceptance-fee table, the one
 * that arrived as a single flattened line and prompted this module.
 *
 * Its two right-hand columns are identical for rows 1–5 and DIFFERENT for the
 * last two rows — which is exactly where a column shift would show up, and
 * exactly the rows a student actually asks about.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  alignRow,
  classifyCell,
  decodeEntities,
  extractTables,
  htmlTableToMarkdown,
  isSeparatorLine,
  isTableLine,
  parseHtmlTable,
  parseMarkdownTable,
  splitMarkdownTable,
  tableSimilarity,
  toMarkdownTable,
  upgradeTablesFromSource,
} from './table-markdown';

/** Mirrors the module's internal cell classification, for the alignment tests. */
type CellType = 'empty' | 'number' | 'text';

const FEE_TABLE_HTML = `
<table>
  <thead>
    <tr>
      <th>S/NO</th><th>ITEMS</th>
      <th>COLLEGE OF MEDICAL SCIENCES CANDIDATES (&#8358;)</th>
      <th>OTHER CANDIDATES (&#8358;)</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>1</td><td>Bank/Portal Charges</td><td>5,000.00</td><td>5,000.00</td></tr>
    <tr><td>2</td><td>Admission Clearance</td><td>30,000.00</td><td>30,000.00</td></tr>
    <tr><td>3</td><td>ICT Levy</td><td>6,000.00</td><td>6,000.00</td></tr>
    <tr><td>4</td><td>Maintenance Fee</td><td>15,000.00</td><td>15,000.00</td></tr>
    <tr><td>5</td><td>MTN Net Library</td><td>4,000.00</td><td>4,000.00</td></tr>
    <tr><td>6</td><td>College Development Levy (Medical Students Only)</td><td>20,000.00</td><td>-</td></tr>
    <tr><td>TOTAL</td><td>80,000.00</td><td>60,000.00</td></tr>
  </tbody>
</table>`;
// ^ THREE cells on the TOTAL row, not four. That is what Unstructured actually
// returns for this page: uniben.edu writes `<td colspan="2">TOTAL</td>` and
// text_as_html drops the colspan. An earlier version of this fixture invented
// a fourth cell, which is why the suite passed while the real page came out
// with its totals a column to the left. Fixtures are observations, not guesses.

describe('parseHtmlTable — the uniben fee table', () => {
  test('recovers the header, including the decoded naira sign', () => {
    const table = parseHtmlTable(FEE_TABLE_HTML)!;
    assert.deepEqual(table.header, [
      'S/NO',
      'ITEMS',
      'COLLEGE OF MEDICAL SCIENCES CANDIDATES (₦)',
      'OTHER CANDIDATES (₦)',
    ]);
  });

  test('recovers every row with its columns intact', () => {
    const table = parseHtmlTable(FEE_TABLE_HTML)!;
    assert.equal(table.rows.length, 7);
    assert.deepEqual(table.rows[0], ['1', 'Bank/Portal Charges', '5,000.00', '5,000.00']);
    // The row where the two columns finally differ — the one a shift breaks.
    assert.deepEqual(table.rows[5], [
      '6',
      'College Development Levy (Medical Students Only)',
      '20,000.00',
      '-',
    ]);
    // The regression that shipped: with the colspan gone, padding on the right
    // put 80,000.00 under ITEMS and 60,000.00 under MEDICAL, so the medical
    // total read as the other-candidates total.
    assert.deepEqual(table.rows[6], ['', 'TOTAL', '80,000.00', '60,000.00']);
    assert.equal(table.rows[6]![2], '80,000.00', 'medical total left its column');
    assert.equal(table.rows[6]![3], '60,000.00', 'other-candidates total left its column');
  });

  test('the extracted figures still reconcile', () => {
    // An arithmetic check beats eyeballing: if a value had landed in the wrong
    // column, the column totals would stop adding up.
    const table = parseHtmlTable(FEE_TABLE_HTML)!;
    const money = (cell: string) => Number(cell.replace(/[^0-9.]/g, '')) || 0;

    // Found by content, not by column: the summary label legitimately moves
    // between the columns its dropped colspan used to span.
    const isTotal = (row: string[]) => row.includes('TOTAL');
    const items = table.rows.filter((r) => !isTotal(r));
    const total = table.rows.find(isTotal)!;

    assert.equal(items.reduce((sum, r) => sum + money(r[2]!), 0), 80_000);
    assert.equal(items.reduce((sum, r) => sum + money(r[3]!), 0), 60_000);
    // And the stated totals agree with the columns they sit above.
    assert.equal(money(total[2]!), 80_000);
    assert.equal(money(total[3]!), 60_000);
  });
});

describe('alignRow — where the gap goes in a short row', () => {
  const money = ['number', 'number'] as const;

  test('a trailing label row right-aligns, keeping figures under their headings', () => {
    // TOTAL | 80,000.00 | 60,000.00  →  _ | TOTAL | 80,000.00 | 60,000.00
    const types = ['number', 'text', ...money] as (CellType | null)[];
    assert.deepEqual(alignRow(['TOTAL', '80,000.00', '60,000.00'], 4, types), [
      '',
      'TOTAL',
      '80,000.00',
      '60,000.00',
    ]);
  });

  test('a row missing its LAST value left-aligns when the types say so', () => {
    // The case a blanket right-align would corrupt. The final column is text
    // here, so placing the figure there scores worse than leaving the gap at
    // the end — the types carry the answer and alignment follows them.
    const types = ['number', 'text', 'number', 'text'] as (CellType | null)[];
    assert.deepEqual(alignRow(['7', 'Extra Fee', '1,000.00'], 4, types), [
      '7',
      'Extra Fee',
      '1,000.00',
      '',
    ]);
  });

  test('a genuine tie resolves to right-alignment, by documented choice', () => {
    // Two adjacent numeric columns and one number to place: nothing in the
    // data says which column is missing, and no cleverness can invent it.
    // Right-alignment wins because a short row is far more often a summary row
    // whose merged label lost its colspan than a row missing a trailing value.
    // Recorded here so the behaviour is a decision, not an accident.
    const types = ['number', 'text', ...money] as (CellType | null)[];
    assert.deepEqual(alignRow(['7', 'Extra Fee', '1,000.00'], 4, types), [
      '7',
      'Extra Fee',
      '',
      '1,000.00',
    ]);
  });

  test('falls back to right-alignment when the columns say nothing', () => {
    // No learned types — the summary-row convention is the safer default.
    assert.deepEqual(alignRow(['a', 'b'], 4, [null, null, null, null]), ['', '', 'a', 'b']);
  });

  test('a full-width row is returned unchanged', () => {
    const types = ['text', 'text'] as (CellType | null)[];
    assert.deepEqual(alignRow(['a', 'b'], 2, types), ['a', 'b']);
  });

  test('an over-wide row is trimmed rather than widening the table', () => {
    assert.deepEqual(alignRow(['a', 'b', 'c'], 2, [null, null]), ['a', 'b']);
  });

  test('an empty row becomes blanks, not a crash', () => {
    assert.deepEqual(alignRow([], 3, [null, null, null]), ['', '', '']);
  });

  test('cell order is always preserved', () => {
    const types = ['text', 'number', 'text', 'number'] as (CellType | null)[];
    const out = alignRow(['x', '1'], 4, types);
    const kept = out.filter((c) => c !== '');
    assert.deepEqual(kept, ['x', '1']);
  });
});

describe('classifyCell', () => {
  test('recognises money, plain numbers and percentages', () => {
    for (const value of ['80,000.00', '5000', '₦20,000.00', '3', '12%']) {
      assert.equal(classifyCell(value), 'number', value);
    }
  });

  test('treats a dash placeholder as an empty value column, not as prose', () => {
    // Row 6's "-" stands in for a figure; calling it text would teach the
    // column the wrong type.
    for (const value of ['-', '–', '—']) assert.equal(classifyCell(value), 'empty', value);
    assert.equal(classifyCell('   '), 'empty');
  });

  test('everything else is text', () => {
    assert.equal(classifyCell('Bank/Portal Charges'), 'text');
    assert.equal(classifyCell('TOTAL'), 'text');
  });
});

describe('parseHtmlTable — structure', () => {
  test('a short row cannot shift a value into the wrong column', () => {
    // The corruption this module exists to prevent, in miniature: the number
    // must stay under the numeric column.
    const table = parseHtmlTable(
      '<table><tr><th>N</th><th>ITEM</th><th>FEE</th></tr>' +
        '<tr><td>1</td><td>ICT Levy</td><td>6,000.00</td></tr>' +
        '<tr><td>TOTAL</td><td>6,000.00</td></tr></table>',
    )!;
    assert.deepEqual(table.rows[1], ['', 'TOTAL', '6,000.00']);
  });

  test('expands colspan into every column it covers', () => {
    const table = parseHtmlTable(
      '<table><tr><th>A</th><th>B</th></tr><tr><td colspan="2">both</td></tr></table>',
    )!;
    assert.deepEqual(table.rows[0], ['both', 'both']);
  });

  test('carries a rowspan value down into the rows it covers', () => {
    const table = parseHtmlTable(
      '<table><tr><th>Faculty</th><th>Course</th></tr>' +
        '<tr><td rowspan="2">Physical Sciences</td><td>CSC111</td></tr>' +
        '<tr><td>CSC112</td></tr></table>',
    )!;
    assert.deepEqual(table.rows[0], ['Physical Sciences', 'CSC111']);
    // Without rowspan handling this row would read ['CSC112', ''] — the course
    // code filed as the faculty.
    assert.deepEqual(table.rows[1], ['Physical Sciences', 'CSC112']);
  });

  test('uses the first row as the header when there is no th', () => {
    const table = parseHtmlTable('<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>')!;
    assert.deepEqual(table.header, ['A', 'B']);
    assert.deepEqual(table.rows, [['1', '2']]);
  });

  test('numbers unlabelled columns rather than emitting a blank header', () => {
    const table = parseHtmlTable('<table><tr><td></td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>')!;
    assert.deepEqual(table.header, ['Column 1', 'B']);
  });

  test('flattens markup and line breaks inside a cell', () => {
    const table = parseHtmlTable(
      '<table><tr><th>A</th></tr><tr><td><b>bold</b><br/>second   line</td></tr></table>',
    )!;
    assert.deepEqual(table.rows[0], ['bold second line']);
  });

  test('refuses a nested table instead of interleaving two grids', () => {
    // Returning null makes the caller fall back to flattened text —
    // wrong-but-complete beats confidently misaligned.
    assert.equal(parseHtmlTable('<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>'), null);
  });

  test('returns null when there is no table at all', () => {
    assert.equal(parseHtmlTable('<p>just prose</p>'), null);
    assert.equal(parseHtmlTable(''), null);
  });

  test('a corrupt span cannot blow up the row width', () => {
    const table = parseHtmlTable('<table><tr><td colspan="9999">x</td></tr><tr><td>y</td></tr></table>')!;
    assert.ok(table.header.length <= 64);
  });
});

describe('decodeEntities', () => {
  test('decodes numeric, hex and named forms', () => {
    assert.equal(decodeEntities('&#8358;80,000'), '₦80,000');
    assert.equal(decodeEntities('&#x20A6;60,000'), '₦60,000');
    assert.equal(decodeEntities('A&amp;B'), 'A&B');
    assert.equal(decodeEntities('a&nbsp;b'), 'a b');
  });

  test('does not double-decode', () => {
    // &amp;#60; is the literal text "&#60;", not "<".
    assert.equal(decodeEntities('&amp;#60;'), '&#60;');
  });

  test('leaves unknown entities alone', () => {
    assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
  });
});

/**
 * Split a rendered row into cells the way a Markdown reader does — on pipes
 * that are NOT escaped. A naive split('|') counts an escaped pipe as a column
 * boundary, which is precisely the confusion the escaping exists to prevent.
 */
const cellsOf = (line: string) => line.split(/(?<!\\)\|/);

describe('toMarkdownTable', () => {
  test('renders header, separator, and one line per row', () => {
    const md = htmlTableToMarkdown(FEE_TABLE_HTML)!;
    const lines = md.split('\n');
    assert.equal(lines.length, 9); // header + separator + 7 rows
    assert.equal(lines[0], '| S/NO | ITEMS | COLLEGE OF MEDICAL SCIENCES CANDIDATES (₦) | OTHER CANDIDATES (₦) |');
    assert.equal(lines[1], '| --- | --- | --- | --- |');
    // TOTAL sits under ITEMS with S/NO blank — the merged label had to land in
    // one of the two columns it spanned, and either reads correctly. What
    // matters is that both figures stayed under their own headings.
    assert.equal(lines[8], '|  | TOTAL | 80,000.00 | 60,000.00 |');
  });

  test('every row carries the same number of columns as the header', () => {
    const md = htmlTableToMarkdown(FEE_TABLE_HTML)!;
    const widths = new Set(md.split('\n').map((line) => cellsOf(line).length));
    assert.equal(widths.size, 1, 'ragged row — a value would be read under the wrong column');
  });

  test('escapes a pipe inside a cell so it cannot forge a column', () => {
    const md = toMarkdownTable({ header: ['A', 'B'], rows: [['x | y', 'z']] });
    const [header, , row] = md.split('\n');
    assert.match(md, /x \\\| y/);
    // The cell keeps its pipe as content; the row still reads as two columns.
    assert.equal(cellsOf(row!).length, cellsOf(header!).length);
  });

  test('returns null for a table with a header and no rows', () => {
    assert.equal(htmlTableToMarkdown('<table><tr><th>A</th></tr></table>'), null);
  });
});

describe('upgradeTablesFromSource — the original HTML wins', () => {
  /** What uniben.edu actually serves: the TOTAL label spans two columns. */
  const SOURCE_PAGE = `
    <html><body>
      <h1>Acceptance Fee</h1>
      <table>
        <tr><th>S/NO</th><th>ITEMS</th><th>MEDICAL</th><th>OTHER</th></tr>
        <tr><td>1</td><td>ICT Levy</td><td>6,000.00</td><td>6,000.00</td></tr>
        <tr><td colspan="2">TOTAL</td><td>80,000.00</td><td>60,000.00</td></tr>
      </table>
    </body></html>`;

  /** What Unstructured hands back for it — colspan gone. */
  const lossy = [
    { type: 'Title', text: 'Acceptance Fee' },
    { type: 'Table', text: 'S/NO ITEMS MEDICAL OTHER 1 ICT Levy 6,000.00 6,000.00 TOTAL 80,000.00 60,000.00' },
  ];

  test('recovers the merged label instead of inferring around it', () => {
    const [, table] = upgradeTablesFromSource(lossy, SOURCE_PAGE);
    const parsed = parseMarkdownTable(table!.text)!;

    // Both columns the colspan covered carry the label — no inference needed.
    assert.equal(parsed.rows[1], '| TOTAL | TOTAL | 80,000.00 | 60,000.00 |');
  });

  test('leaves non-Table elements untouched', () => {
    const [title] = upgradeTablesFromSource(lossy, SOURCE_PAGE);
    assert.deepEqual(title, { type: 'Title', text: 'Acceptance Fee' });
  });

  test('matches by content, not by position', () => {
    const twoTables = `
      <table><tr><th>CODE</th><th>UNITS</th></tr><tr><td>CSC111</td><td>3</td></tr></table>
      <table><tr><th>ITEM</th><th>FEE</th></tr><tr><td>ICT Levy</td><td>6,000.00</td></tr></table>`;
    // Deliberately reversed relative to the source order.
    const elements = [
      { type: 'Table', text: 'ITEM FEE ICT Levy 6,000.00' },
      { type: 'Table', text: 'CODE UNITS CSC111 3' },
    ];

    const [first, second] = upgradeTablesFromSource(elements, twoTables);
    assert.match(first!.text, /ICT Levy/);
    assert.match(second!.text, /CSC111/);
    assert.doesNotMatch(first!.text, /CSC111/);
  });

  test('a source table is consumed at most once', () => {
    const source = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const elements = [
      { type: 'Table', text: 'A B 1 2' },
      { type: 'Table', text: 'A B 1 2' },
    ];
    const [first, second] = upgradeTablesFromSource(elements, source);

    assert.notEqual(parseMarkdownTable(first!.text), null, 'the first should be upgraded');
    // The second has no source left to claim, so it keeps its own text rather
    // than being handed a copy of a table it is not.
    assert.equal(second!.text, 'A B 1 2');
  });

  test('an unrelated table is not substituted', () => {
    const source = '<table><tr><th>CODE</th><th>UNITS</th></tr><tr><td>CSC111</td><td>3</td></tr></table>';
    const elements = [{ type: 'Table', text: 'Completely different content about hostel allocation' }];
    assert.equal(upgradeTablesFromSource(elements, source)[0]!.text, elements[0]!.text);
  });

  test('HTML with no table changes nothing', () => {
    assert.deepEqual(upgradeTablesFromSource(lossy, '<p>no tables here</p>'), lossy);
    assert.deepEqual(upgradeTablesFromSource(lossy, ''), lossy);
  });
});

describe('extractTables', () => {
  test('returns each table in document order', () => {
    const tables = extractTables('<p>a</p><table><tr><td>1</td></tr></table><p>b</p><table><tr><td>2</td></tr></table>');
    assert.equal(tables.length, 2);
    assert.match(tables[0]!, /<td>1<\/td>/);
    assert.match(tables[1]!, /<td>2<\/td>/);
  });

  test('returns nothing when there is no table', () => {
    assert.deepEqual(extractTables('<p>prose</p>'), []);
  });
});

describe('tableSimilarity', () => {
  test('identical content scores 1', () => {
    assert.equal(tableSimilarity('a b 1 2', 'a b 1 2'), 1);
  });

  test('ignores markup and ordering of the rendering', () => {
    assert.ok(tableSimilarity('ITEM FEE ICT Levy 6,000.00', '| ITEM | FEE |\n| ICT Levy | 6,000.00 |') > 0.9);
  });

  test('unrelated content scores near zero', () => {
    assert.ok(tableSimilarity('hostel allocation policy', 'CODE UNITS CSC111 3') < 0.3);
  });

  test('empty input scores zero rather than dividing by zero', () => {
    assert.equal(tableSimilarity('', 'a b'), 0);
    assert.equal(tableSimilarity('a b', ''), 0);
  });
});

describe('isTableLine / isSeparatorLine', () => {
  test('recognises table lines', () => {
    assert.equal(isTableLine('| a | b |'), true);
    assert.equal(isTableLine('  | a | b |  '), true);
    assert.equal(isTableLine('a | b'), false);
    assert.equal(isTableLine('|'), false);
    assert.equal(isTableLine(''), false);
  });

  test('recognises only real separators', () => {
    assert.equal(isSeparatorLine('| --- | --- |'), true);
    assert.equal(isSeparatorLine('|:---|---:|'), true);
    assert.equal(isSeparatorLine('| a | b |'), false);
    // No dash — a row of empty cells is not a separator.
    assert.equal(isSeparatorLine('|   |   |'), false);
  });
});

describe('parseMarkdownTable', () => {
  test('requires a separator on the second line', () => {
    assert.notEqual(parseMarkdownTable('| a |\n| --- |\n| 1 |'), null);
    // Prose that merely starts with a pipe is not a table.
    assert.equal(parseMarkdownTable('| a |\n| b |\n| c |'), null);
    assert.equal(parseMarkdownTable('just prose'), null);
  });

  test('splits header, separator and rows', () => {
    const parsed = parseMarkdownTable('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')!;
    assert.equal(parsed.header, '| a | b |');
    assert.deepEqual(parsed.rows, ['| 1 | 2 |', '| 3 | 4 |']);
  });
});

describe('splitMarkdownTable — the header travels with the rows', () => {
  const md = htmlTableToMarkdown(FEE_TABLE_HTML)!;

  test('a table that fits comes back whole', () => {
    assert.deepEqual(splitMarkdownTable(md, 10_000), [md]);
  });

  test('every fragment repeats the header and separator', () => {
    // THE POINT OF ALL THIS. Without it, fragment two of a course catalogue is
    // a wall of unlabelled codes, titles and unit counts.
    const fragments = splitMarkdownTable(md, 200);
    assert.ok(fragments.length > 1, 'expected the budget to force a split');

    const [header, separator] = md.split('\n');
    for (const fragment of fragments) {
      const lines = fragment.split('\n');
      assert.equal(lines[0], header);
      assert.equal(lines[1], separator);
      assert.ok(lines.length > 2, 'a fragment must carry at least one row');
    }
  });

  test('no row is lost or duplicated across fragments', () => {
    const rows = parseMarkdownTable(md)!.rows;
    const recovered = splitMarkdownTable(md, 200).flatMap((f) => parseMarkdownTable(f)!.rows);
    assert.deepEqual(recovered, rows);
  });

  test('a row longer than the budget is emitted whole, never cut', () => {
    // Half a fee is not a smaller fee — a truncated row is a wrong row.
    const wide = `| a | b |\n| --- | --- |\n| ${'x'.repeat(500)} | 5,000.00 |`;
    const fragments = splitMarkdownTable(wide, 50);
    assert.equal(fragments.length, 1);
    assert.ok(fragments[0]!.includes('x'.repeat(500)));
    assert.ok(fragments[0]!.includes('5,000.00'));
  });

  test('non-table text passes through untouched', () => {
    assert.deepEqual(splitMarkdownTable('just prose', 10), ['just prose']);
  });
});
