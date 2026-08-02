// episteme-core/src/mastra/ingestion/chunker-tables.test.ts
/**
 * Table-aware chunking.
 *
 * Two claims are being defended here, and the second matters as much as the
 * first:
 *
 *   1. A table's header reaches every chunk its rows reach.
 *   2. A document with NO table chunks exactly as it did before any of this
 *      existed. The change is additive — it can only ever affect a document
 *      that contains a table.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchicalChunks, splitIntoBlocks } from './chunker';
import { parseMarkdownTable } from './table-markdown';

const TABLE = [
  '| S/NO | ITEMS | MEDICAL (₦) | OTHER (₦) |',
  '| --- | --- | --- | --- |',
  '| 1 | Bank/Portal Charges | 5,000.00 | 5,000.00 |',
  '| 2 | Admission Clearance | 30,000.00 | 30,000.00 |',
  '| 3 | ICT Levy | 6,000.00 | 6,000.00 |',
  '| 4 | Maintenance Fee | 15,000.00 | 15,000.00 |',
  '| 5 | MTN Net Library | 4,000.00 | 4,000.00 |',
  '| 6 | College Development Levy (Medical Students Only) | 20,000.00 | - |',
  '| TOTAL |  | 80,000.00 | 60,000.00 |',
].join('\n');

describe('splitIntoBlocks — additive by construction', () => {
  test('text with no table is ONE prose block spanning the whole input', () => {
    // This is the guarantee. One prose block covering the entire text means
    // the chunking call made for a table-free document is character-for-
    // character the call that was made before table handling existed.
    const text = 'A heading\n\nSome prose about admission requirements.\n\nMore prose.';
    const blocks = splitIntoBlocks(text);

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.kind, 'prose');
    assert.equal(blocks[0]!.text, text, 'the block must be the untouched input');
    assert.equal(blocks[0]!.offset, 0);
  });

  test('an empty input stays a single block', () => {
    assert.deepEqual(splitIntoBlocks(''), [{ kind: 'prose', text: '', offset: 0 }]);
  });

  test('prose that merely contains pipes is not mistaken for a table', () => {
    // No separator line, so it is not a table — a pipe in prose or a code
    // sample must not divert the document down the table path.
    const text = 'Run this:\n| grep foo\n| sort\nDone.';
    const blocks = splitIntoBlocks(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.kind, 'prose');
  });

  test('isolates a table from the prose around it', () => {
    const text = `Intro paragraph.\n\n${TABLE}\n\nClosing paragraph.`;
    const blocks = splitIntoBlocks(text);

    assert.deepEqual(blocks.map((b) => b.kind), ['prose', 'table', 'prose']);
    assert.equal(blocks[1]!.text, TABLE);
    assert.match(blocks[0]!.text, /Intro paragraph/);
    assert.match(blocks[2]!.text, /Closing paragraph/);
  });

  test('block offsets point at the block in the source text', () => {
    const text = `Intro paragraph.\n\n${TABLE}\n\nClosing paragraph.`;
    for (const block of splitIntoBlocks(text)) {
      assert.equal(text.slice(block.offset, block.offset + block.text.length), block.text);
    }
  });

  test('blocks reassemble into the source text', () => {
    // Nothing may be dropped between blocks: a lost gap is lost content.
    const text = `Intro.\n\n${TABLE}\n\nMiddle.\n\n${TABLE}\n\nEnd.`;
    const blocks = splitIntoBlocks(text);
    const covered = blocks.map((b) => b.text).join('');
    const withoutGaps = text.replace(/\n{2,}/g, '');
    assert.equal(covered.replace(/\n{2,}/g, ''), withoutGaps);
  });

  test('handles two tables back to back', () => {
    const text = `${TABLE}\n\n${TABLE}`;
    assert.deepEqual(splitIntoBlocks(text).map((b) => b.kind), ['table', 'table']);
  });

  test('a table at the very start and very end is still found', () => {
    assert.deepEqual(splitIntoBlocks(TABLE).map((b) => b.kind), ['table']);
    assert.deepEqual(splitIntoBlocks(`${TABLE}\n\ntail`).map((b) => b.kind), ['table', 'prose']);
    assert.deepEqual(splitIntoBlocks(`head\n\n${TABLE}`).map((b) => b.kind), ['prose', 'table']);
  });
});

describe('buildHierarchicalChunks — tables keep their header', () => {
  test('a small table survives as one parent, intact', async () => {
    const parents = await buildHierarchicalChunks(TABLE, 'doc', 'admissions', 'general');
    const tableParents = parents.filter((p) => parseMarkdownTable(p.text) !== null);

    assert.equal(tableParents.length, 1);
    const parsed = parseMarkdownTable(tableParents[0]!.text)!;
    assert.equal(parsed.rows.length, 7);
    assert.match(parsed.header, /MEDICAL/);
  });

  test('every child of a table parent carries the header', async () => {
    // The child is the EMBEDDED unit. Before this, a 512-char window could hold
    // "| 6 | College Development Levy | 20,000.00 | - |" with no column labels
    // anywhere in it — four values and nothing saying which candidate they
    // apply to.
    const parents = await buildHierarchicalChunks(TABLE, 'doc', 'admissions', 'general');
    const tableParent = parents.find((p) => parseMarkdownTable(p.text) !== null)!;

    assert.ok(tableParent.children.length > 0);
    for (const child of tableParent.children) {
      const parsed = parseMarkdownTable(child.text);
      assert.notEqual(parsed, null, `child is not a well-formed table:\n${child.text}`);
      assert.match(parsed!.header, /MEDICAL/);
      assert.ok(parsed!.rows.length > 0, 'a child must carry at least one row');
    }
  });

  test('no row is lost across a table parent and its children', async () => {
    const parents = await buildHierarchicalChunks(TABLE, 'doc', 'admissions', 'general');
    const tableParent = parents.find((p) => parseMarkdownTable(p.text) !== null)!;

    const parentRows = parseMarkdownTable(tableParent.text)!.rows;
    const childRows = tableParent.children.flatMap((c) => parseMarkdownTable(c.text)!.rows);
    assert.deepEqual(childRows, parentRows);
  });

  test('the fee figures still reconcile after chunking', async () => {
    // End to end: if chunking had shifted a value into another column, the
    // per-column totals would stop matching the TOTAL row.
    const parents = await buildHierarchicalChunks(TABLE, 'doc', 'admissions', 'general');
    const tableParent = parents.find((p) => parseMarkdownTable(p.text) !== null)!;
    const rows = parseMarkdownTable(tableParent.text)!.rows.map((r) =>
      r.split('|').slice(1, -1).map((c) => c.trim()),
    );

    const money = (cell: string) => Number(cell.replace(/[^0-9.]/g, '')) || 0;
    const items = rows.filter((r) => r[0] !== 'TOTAL');
    const total = rows.find((r) => r[0] === 'TOTAL')!;

    assert.equal(items.reduce((s, r) => s + money(r[2]!), 0), money(total[2]!));
    assert.equal(items.reduce((s, r) => s + money(r[3]!), 0), money(total[3]!));
    assert.equal(money(total[2]!), 80_000);
    assert.equal(money(total[3]!), 60_000);
  });

  test('a table beside prose does not swallow the prose', async () => {
    const text = `Acceptance fees are payable on admission.\n\n${TABLE}\n\nPay before resumption.`;
    const parents = await buildHierarchicalChunks(text, 'doc', 'admissions', 'general');
    const all = parents.map((p) => p.text).join('\n');

    assert.match(all, /Acceptance fees are payable/);
    assert.match(all, /Pay before resumption/);
    assert.ok(parents.some((p) => parseMarkdownTable(p.text) !== null), 'the table did not survive');
  });

  test('a table-free document still chunks', async () => {
    // The additive guarantee, exercised through the real function rather than
    // only through splitIntoBlocks.
    const prose = 'Admission requirements. '.repeat(200);
    const parents = await buildHierarchicalChunks(prose, 'doc', 'admissions', 'general');

    assert.ok(parents.length > 0);
    assert.ok(parents.every((p) => p.children.length > 0));
    assert.ok(parents.every((p) => parseMarkdownTable(p.text) === null));
  });
});

describe('buildHierarchicalChunks — a long table', () => {
  /** 120 rows: comfortably past a 2048-char parent, like a course catalogue. */
  const longTable = [
    '| CODE | TITLE | UNITS | PREREQUISITE |',
    '| --- | --- | --- | --- |',
    ...Array.from(
      { length: 120 },
      (_, i) => `| CSC${101 + i} | Computer Science Topic Number ${i + 1} | ${(i % 4) + 1} | CSC${100 + i} |`,
    ),
  ].join('\n');

  test('splits into several parents, each a complete table', async () => {
    const parents = await buildHierarchicalChunks(longTable, 'doc', 'programmes', 'catalogue');
    const tableParents = parents.filter((p) => parseMarkdownTable(p.text) !== null);

    assert.ok(tableParents.length > 1, 'expected the table to exceed one parent');
    for (const parent of tableParents) {
      const parsed = parseMarkdownTable(parent.text)!;
      // Every fragment names its own columns. This is the failure mode the
      // whole change exists for: without it, fragment two onward is a wall of
      // codes, titles and unit counts with no labels.
      assert.equal(parsed.header, '| CODE | TITLE | UNITS | PREREQUISITE |');
      assert.ok(parsed.rows.length > 0);
    }
  });

  test('every row appears exactly once across all parents', async () => {
    const parents = await buildHierarchicalChunks(longTable, 'doc', 'programmes', 'catalogue');
    const rows = parents
      .filter((p) => parseMarkdownTable(p.text) !== null)
      .flatMap((p) => parseMarkdownTable(p.text)!.rows);

    assert.equal(rows.length, 120, 'rows were lost or duplicated');
    assert.equal(new Set(rows).size, 120);
    assert.match(rows[0]!, /CSC101/);
    assert.match(rows[119]!, /CSC220/);
  });

  test('no chunk is a header-less run of values', async () => {
    const parents = await buildHierarchicalChunks(longTable, 'doc', 'programmes', 'catalogue');
    for (const parent of parents) {
      for (const child of parent.children) {
        assert.match(child.text, /\| CODE \| TITLE \| UNITS \| PREREQUISITE \|/);
      }
    }
  });
});
