// scorers/episteme-scorer.test.ts
//
// Regression cover for extractEntities, which decides what faithfulness scores.
//
// The cases below are not invented: they are the exact strings the 2026-08-13
// prompt-eval run reported as "ungrounded". Three of the four hallucinations it
// found in direct-policy-question were that answer's own list labels, and
// platform-help-public-tier scored 0.00 for the heading fragment
// "Use This Assistant". A scorer that reads formatting as fabrication makes the
// system look worse the better it writes, so the boundary is worth pinning.
//
// The second half of this file matters as much as the first: it asserts what
// must STILL be caught. Loosening the extractor until nothing is ever flagged
// would produce a flattering faithfulness number, which is a worse outcome for
// an evaluation than the over-strict version being fixed.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities } from './episteme-scorer';

describe('extractEntities — presentation is not a claim', () => {
  test('a markdown heading is not an entity', () => {
    const entities = extractEntities('### How to Use This Assistant\n\nAsk specific questions.');
    assert.ok(!entities.includes('Use This Assistant'), `got: ${entities.join(', ')}`);
    assert.ok(!entities.includes('How To Use'));
  });

  test('headings at every level are stripped', () => {
    for (const hashes of ['#', '##', '###', '####', '#####', '######']) {
      const entities = extractEntities(`${hashes} Grade Point Conversion\n\nbody text`);
      assert.ok(
        !entities.includes('Grade Point Conversion'),
        `${hashes} leaked: ${entities.join(', ')}`,
      );
    }
  });

  test('a bold label opening a numbered list item is not an entity', () => {
    const answer = [
      '1. **Grade Point Conversion**: Convert your percentage marks into grade points.',
      '2. **Compute Total Units and Grade Points**:',
    ].join('\n');
    const entities = extractEntities(answer);

    // The three false positives from the measured run.
    assert.ok(!entities.includes('Grade Point Conversion'), `got: ${entities.join(', ')}`);
    assert.ok(!entities.includes('Compute Total Units'), `got: ${entities.join(', ')}`);
    assert.ok(!entities.includes('Total Units'), `got: ${entities.join(', ')}`);
  });

  test('bullet and paren-numbered list labels are stripped too', () => {
    for (const marker of ['-', '*', '+', '1.', '2)']) {
      const entities = extractEntities(`${marker} **Academic Board Policy**: see the handbook.`);
      assert.ok(
        !entities.includes('Academic Board Policy'),
        `marker "${marker}" leaked: ${entities.join(', ')}`,
      );
    }
  });
});

describe('extractEntities — real claims are still extracted', () => {
  test('a bolded person mid-sentence is still an entity', () => {
    const entities = extractEntities(
      'The current Vice Chancellor is **Professor Edoba Bright Omoregie**, appointed by council.',
    );
    assert.ok(
      entities.some((e) => e.includes('Edoba Bright Omoregie')),
      `person was dropped: ${entities.join(', ')}`,
    );
  });

  test('a bold span inside prose is not mistaken for a list label', () => {
    const entities = extractEntities('Applications go to the **Records Office** before Friday.');
    assert.ok(entities.includes('Records Office'), `got: ${entities.join(', ')}`);
  });

  test('plain multi-word proper nouns survive', () => {
    const entities = extractEntities('Issued by the University of Benin Senate.');
    assert.ok(
      entities.some((e) => e.includes('Benin')),
      `got: ${entities.join(', ')}`,
    );
  });

  test('grade points remain extractable, including a lone fabricated row', () => {
    const answer = [
      '1. **Grade Point Conversion**: use the scale below.',
      '   - A = 5.0',
      '   - F = 0.0',
    ].join('\n');
    const entities = extractEntities(answer);

    // The label goes; the numbers stay. 0.0 was a genuine finding on the
    // measured run — every other grade point was grounded and it alone was not.
    assert.ok(!entities.includes('Grade Point Conversion'));
    assert.ok(entities.includes('5.0'), `got: ${entities.join(', ')}`);
    assert.ok(entities.includes('0.0'), `got: ${entities.join(', ')}`);
  });

  test('numerics inside a heading are still extracted', () => {
    // Presentation is stripped for proper nouns ONLY. A fabricated year is a
    // fabrication wherever it appears, so headings must not become a blind spot.
    const entities = extractEntities('## Deadlines for 2027\n\nSee the calendar.');
    assert.ok(entities.includes('2027'), `year was dropped: ${entities.join(', ')}`);
  });

  test('percentages and course codes survive', () => {
    const entities = extractEntities('A pass in CSC 201 requires 40% overall.');
    assert.ok(entities.includes('40%') || entities.includes('40 %'), `got: ${entities.join(', ')}`);
    assert.ok(
      entities.some((e) => e.replace(/\s+/g, '') === 'CSC201'),
      `course code dropped: ${entities.join(', ')}`,
    );
  });
});

describe('extractEntities — degenerate input', () => {
  test('empty text yields no entities', () => {
    assert.deepEqual(extractEntities(''), []);
  });

  test('a document that is nothing but headings yields no proper nouns', () => {
    const entities = extractEntities('# Title Here\n## Section Two\n### Sub Section');
    assert.deepEqual(entities, []);
  });

  test('entities are de-duplicated', () => {
    const entities = extractEntities('Records Office. Again the Records Office.');
    assert.equal(entities.filter((e) => e === 'Records Office').length, 1);
  });
});
