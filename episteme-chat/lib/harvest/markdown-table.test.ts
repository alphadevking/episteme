// lib/harvest/markdown-table.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSeparatorLine,
  isTableLine,
  parsePipeTable,
  splitIntoRuns,
  splitRow,
  type PipeTable,
} from './markdown-table';

/** Parse, asserting success — a failure names the input instead of throwing a TypeError. */
function mustParse(text: string): PipeTable {
  const table = parsePipeTable(text);
  assert.ok(table, `expected a pipe table:\n${text}`);
  return table;
}

const FEE_TABLE = [
  '| S/NO | ITEMS | MEDICAL (₦) | OTHER (₦) |',
  '| --- | --- | --- | --- |',
  '| 1 | Bank/Portal Charges | 5,000.00 | 5,000.00 |',
  '| 6 | College Development Levy (Medical Students Only) | 20,000.00 | - |',
  '| TOTAL |  | 80,000.00 | 60,000.00 |',
].join('\n');

describe('splitRow', () => {
  test('splits a row into trimmed cells', () => {
    assert.deepEqual(splitRow('| 1 | Bank/Portal Charges | 5,000.00 |'), [
      '1',
      'Bank/Portal Charges',
      '5,000.00',
    ]);
  });

  test('keeps an empty cell rather than collapsing it', () => {
    // Dropping the empty TOTAL label would shift 80,000.00 into the ITEMS
    // column — the display version of the bug this all exists to prevent.
    assert.deepEqual(splitRow('| TOTAL |  | 80,000.00 | 60,000.00 |'), [
      'TOTAL',
      '',
      '80,000.00',
      '60,000.00',
    ]);
  });

  test('an escaped pipe stays inside its cell', () => {
    assert.deepEqual(splitRow('| a \\| b | c |'), ['a | b', 'c']);
  });

  test('keeps trailing text when the row is not pipe-terminated', () => {
    assert.deepEqual(splitRow('| a | b'), ['a', 'b']);
  });
});

describe('parsePipeTable', () => {
  test('reads the uniben fee table', () => {
    const table = mustParse(FEE_TABLE);
    assert.deepEqual(table.header, ['S/NO', 'ITEMS', 'MEDICAL (₦)', 'OTHER (₦)']);
    assert.equal(table.rows.length, 3);
    assert.deepEqual(table.rows[1], [
      '6',
      'College Development Levy (Medical Students Only)',
      '20,000.00',
      '-',
    ]);
    assert.deepEqual(table.rows[2], ['TOTAL', '', '80,000.00', '60,000.00']);
  });

  test('every rendered row matches the header width', () => {
    const table = mustParse(FEE_TABLE);
    for (const row of table.rows) {
      assert.equal(row.length, table.header.length);
    }
  });

  test('pads a short row instead of misaligning the rest', () => {
    const table = mustParse('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |');
    assert.deepEqual(table.rows[0], ['1', '2', '']);
  });

  test('trims a row that has too many cells', () => {
    const table = mustParse('| a | b |\n| --- | --- |\n| 1 | 2 | 3 |');
    assert.deepEqual(table.rows[0], ['1', '2']);
  });

  test('requires a separator line', () => {
    assert.equal(parsePipeTable('| a | b |\n| 1 | 2 |'), null);
    assert.equal(parsePipeTable('not a table'), null);
    assert.equal(parsePipeTable('| a |'), null);
  });

  test('the figures reconcile after parsing', () => {
    const table = mustParse(FEE_TABLE);
    const money = (cell: string) => Number(cell.replace(/[^0-9.]/g, '')) || 0;
    const total = table.rows.find((r) => r[0] === 'TOTAL');
    assert.ok(total, 'no TOTAL row');
    assert.equal(money(total[2]), 80_000);
    assert.equal(money(total[3]), 60_000);
  });
});

describe('isTableLine / isSeparatorLine', () => {
  test('recognise table and separator lines', () => {
    assert.equal(isTableLine('| a | b |'), true);
    assert.equal(isTableLine('a | b'), false);
    assert.equal(isSeparatorLine('| --- | --- |'), true);
    assert.equal(isSeparatorLine('| a | b |'), false);
  });
});

describe('splitIntoRuns', () => {
  test('separates prose from a table, in order', () => {
    const runs = splitIntoRuns(`Acceptance fees:\n${FEE_TABLE}\nPay before resumption.`);
    assert.deepEqual(runs.map((r) => r.kind), ['prose', 'table', 'prose']);
  });

  test('a chunk that is only a table yields one table run', () => {
    const runs = splitIntoRuns(FEE_TABLE);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].kind, 'table');
  });

  test('a chunk with no table yields one prose run', () => {
    const runs = splitIntoRuns('Just some prose.\nOn two lines.');
    assert.deepEqual(runs, [{ kind: 'prose', text: 'Just some prose.\nOn two lines.' }]);
  });

  test('prose containing a stray pipe stays prose', () => {
    const runs = splitIntoRuns('Run this:\n| grep foo\n| sort');
    assert.deepEqual(runs.map((r) => r.kind), ['prose']);
  });

  test('handles two tables in one chunk', () => {
    const runs = splitIntoRuns(`${FEE_TABLE}\nbetween\n${FEE_TABLE}`);
    assert.deepEqual(runs.map((r) => r.kind), ['table', 'prose', 'table']);
  });

  test('nothing is dropped — every source line survives somewhere', () => {
    // A preview that silently loses a line is worse than one that renders it
    // badly: the reviewer approves content they were never shown.
    const text = `Intro line.\n${FEE_TABLE}\nOutro line.`;
    const runs = splitIntoRuns(text);

    const rendered = runs
      .map((run) =>
        run.kind === 'prose'
          ? run.text
          : [run.table.header.join(' '), ...run.table.rows.map((r) => r.join(' '))].join(' '),
      )
      .join(' ');

    assert.match(rendered, /Intro line\./);
    assert.match(rendered, /Outro line\./);
    assert.match(rendered, /Bank\/Portal Charges/);
    assert.match(rendered, /80,000\.00/);
    assert.match(rendered, /60,000\.00/);
  });

  test('an empty chunk yields no runs', () => {
    assert.deepEqual(splitIntoRuns(''), []);
    assert.deepEqual(splitIntoRuns('   \n  '), []);
  });
});
