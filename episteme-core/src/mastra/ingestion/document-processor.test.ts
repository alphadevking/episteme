// episteme-core/src/mastra/ingestion/document-processor.test.ts
/**
 * Element handling that does not need the Unstructured API.
 *
 * `preferTableMarkdown` is split out of processDocument precisely so the table
 * decision can be tested without a network call — it is the line that used to
 * discard `metadata.text_as_html`, and the one place a regression would be
 * invisible until a fee table came back with its columns shuffled.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPageOffsetMap,
  elementsToText,
  pageAtOffset,
  preferTableMarkdown,
  processMarkdown,
  processPlainText,
} from './document-processor';
import { parseMarkdownTable } from './table-markdown';

const TABLE_HTML =
  '<table><thead><tr><th>ITEMS</th><th>MEDICAL</th><th>OTHER</th></tr></thead>' +
  '<tbody><tr><td>ICT Levy</td><td>6,000.00</td><td>6,000.00</td></tr>' +
  '<tr><td>College Development Levy</td><td>20,000.00</td><td>-</td></tr></tbody></table>';

const FLAT_TEXT = 'ITEMS MEDICAL OTHER ICT Levy 6,000.00 6,000.00 College Development Levy 20,000.00 -';

describe('preferTableMarkdown — additive', () => {
  test('converts a Table element that carries HTML', () => {
    const text = preferTableMarkdown('Table', FLAT_TEXT, TABLE_HTML);
    const parsed = parseMarkdownTable(text);
    assert.notEqual(parsed, null, 'expected a Markdown table');
    assert.equal(parsed!.rows.length, 2);
    assert.match(parsed!.header, /MEDICAL/);
    // The row where the columns differ — the one a shift corrupts.
    assert.match(parsed!.rows[1]!, /\| College Development Levy \| 20,000\.00 \| - \|/);
  });

  test('leaves a non-Table element completely alone', () => {
    const prose = 'Upon successful payment, students must upload the following documents.';
    assert.equal(preferTableMarkdown('NarrativeText', prose, TABLE_HTML), prose);
    assert.equal(preferTableMarkdown('Title', 'Admission Requirements', undefined), 'Admission Requirements');
  });

  test('falls back to the flattened text when there is no HTML', () => {
    // The upgrade must never empty a table. Wrong-but-complete beats missing.
    assert.equal(preferTableMarkdown('Table', FLAT_TEXT, undefined), FLAT_TEXT);
    assert.equal(preferTableMarkdown('Table', FLAT_TEXT, null), FLAT_TEXT);
    assert.equal(preferTableMarkdown('Table', FLAT_TEXT, ''), FLAT_TEXT);
    assert.equal(preferTableMarkdown('Table', FLAT_TEXT, '   '), FLAT_TEXT);
    assert.equal(preferTableMarkdown('Table', FLAT_TEXT, 42), FLAT_TEXT);
  });

  test('falls back when the HTML cannot be parsed into a grid', () => {
    assert.equal(preferTableMarkdown('Table', FLAT_TEXT, '<p>not a table</p>'), FLAT_TEXT);
    assert.equal(preferTableMarkdown('Table', FLAT_TEXT, '<table><tr><th>only a header</th></tr></table>'), FLAT_TEXT);
  });
});

describe('processMarkdown — table lines stay together', () => {
  test('groups a pipe table into one Table element', () => {
    // Per line, elementsToText would put a blank line between every row and
    // the table would no longer be contiguous — invisible to the chunker.
    const md = ['# Fees', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |', '', 'After.'].join('\n');
    const elements = processMarkdown(md, 'general');

    assert.deepEqual(elements.map((e) => e.type), ['Title', 'Table', 'NarrativeText']);
    assert.equal(elements[1]!.text, '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
    assert.equal(elements[2]!.text, 'After.');
  });

  test('the grouped table survives elementsToText as a contiguous block', () => {
    const md = ['Intro.', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    const text = elementsToText(processMarkdown(md, 'general'));

    assert.match(text, /\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  });

  test('non-table markdown keeps its previous per-line handling', () => {
    const md = ['# Title', '- bullet one', '1. numbered', 'plain prose'].join('\n');
    const elements = processMarkdown(md, 'general');

    assert.deepEqual(elements.map((e) => e.type), ['Title', 'ListItem', 'ListItem', 'NarrativeText']);
    assert.deepEqual(elements.map((e) => e.text), ['# Title', '- bullet one', '1. numbered', 'plain prose']);
  });

  test('two tables separated by prose stay separate', () => {
    const md = ['| A |', '| --- |', '| 1 |', 'between', '| B |', '| --- |', '| 2 |'].join('\n');
    assert.deepEqual(processMarkdown(md, 'general').map((e) => e.type), [
      'Table',
      'NarrativeText',
      'Table',
    ]);
  });

  test('a table at the end of the document is not dropped', () => {
    const elements = processMarkdown('Intro.\n| A |\n| --- |\n| 1 |', 'general');
    assert.equal(elements.length, 2);
    assert.equal(elements[1]!.text, '| A |\n| --- |\n| 1 |');
  });
});

describe('processPlainText', () => {
  test('splits on blank lines and flattens each paragraph', () => {
    const elements = processPlainText('One\nline.\n\nSecond para.', 'general');
    assert.deepEqual(elements.map((e) => e.text), ['One line.', 'Second para.']);
  });
});

describe('page offsets stay in step with elementsToText', () => {
  test('each element resolves to its own page', () => {
    const elements = [
      { text: 'first', type: 'NarrativeText', pageNumber: 1, category: 'general' },
      { text: 'second', type: 'NarrativeText', pageNumber: 2, category: 'general' },
      { text: 'third', type: 'NarrativeText', pageNumber: 3, category: 'general' },
    ];
    const text = elementsToText(elements);
    const map = buildPageOffsetMap(elements);

    for (const element of elements) {
      assert.equal(pageAtOffset(map, text.indexOf(element.text)), element.pageNumber);
    }
  });
});
