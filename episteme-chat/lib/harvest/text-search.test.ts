// lib/harvest/text-search.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { countMatches, findMatches, segmentByMatches } from './text-search';

describe('findMatches', () => {
  test('finds every occurrence, in order', () => {
    assert.deepEqual(findMatches('the cat sat on the mat', 'at'), [
      { start: 5, end: 7 },
      { start: 9, end: 11 },
      { start: 20, end: 22 },
    ]);
  });

  test('is case-insensitive but reports the original positions', () => {
    const ranges = findMatches('Admission Requirements', 'REQUIREMENTS');
    assert.deepEqual(ranges, [{ start: 10, end: 22 }]);
    assert.equal('Admission Requirements'.slice(10, 22), 'Requirements');
  });

  test('matches do not overlap', () => {
    // "aa" in "aaa" is one match. Overlapping would also mean the cursor can
    // fail to advance past a match, which is the hang this guards against.
    assert.deepEqual(findMatches('aaa', 'aa'), [{ start: 0, end: 2 }]);
  });

  test('an empty or whitespace query matches nothing', () => {
    // A zero-length needle matches at every index and never advances the
    // cursor — the loop would not terminate.
    assert.deepEqual(findMatches('anything', ''), []);
    assert.deepEqual(findMatches('anything', '   '), []);
  });

  test('leading and trailing whitespace in the query is ignored', () => {
    assert.deepEqual(findMatches('the cat', '  cat  '), [{ start: 4, end: 7 }]);
  });

  test('no match returns an empty list', () => {
    assert.deepEqual(findMatches('the cat', 'dog'), []);
  });

  test('a match at the very start and very end is found', () => {
    assert.deepEqual(findMatches('abcabc', 'abc'), [
      { start: 0, end: 3 },
      { start: 3, end: 6 },
    ]);
  });
});

describe('countMatches', () => {
  test('sums across texts', () => {
    assert.equal(countMatches(['the cat', 'cat and cat'], 'cat'), 3);
  });

  test('is zero for an empty query rather than counting every position', () => {
    assert.equal(countMatches(['the cat'], ''), 0);
  });

  test('is zero for no texts', () => {
    assert.equal(countMatches([], 'cat'), 0);
  });
});

describe('segmentByMatches', () => {
  test('alternates plain and matched segments', () => {
    assert.deepEqual(segmentByMatches('the cat sat', 'cat'), [
      { text: 'the ', match: false, start: 0 },
      { text: 'cat', match: true, start: 4 },
      { text: ' sat', match: false, start: 7 },
    ]);
  });

  test('handles a match at the start and at the end', () => {
    assert.deepEqual(segmentByMatches('cat', 'cat'), [{ text: 'cat', match: true, start: 0 }]);
    assert.deepEqual(segmentByMatches('a cat', 'cat'), [
      { text: 'a ', match: false, start: 0 },
      { text: 'cat', match: true, start: 2 },
    ]);
  });

  test('returns the whole text as one plain segment when nothing matches', () => {
    assert.deepEqual(segmentByMatches('the cat', 'dog'), [{ text: 'the cat', match: false, start: 0 }]);
    assert.deepEqual(segmentByMatches('the cat', ''), [{ text: 'the cat', match: false, start: 0 }]);
  });

  test('segments always reassemble into the original text', () => {
    // The property that matters: a reviewer judging extracted content must
    // never be shown a version the highlighter altered.
    const texts = [
      'the cat sat on the mat',
      'Admission Requirements — UNIBEN',
      'aaa',
      '',
      'no match here',
      'edge case at end: cat',
    ];
    for (const text of texts) {
      for (const query of ['at', 'cat', 'a', 'UNIBEN', 'zzz', '']) {
        const rebuilt = segmentByMatches(text, query).map((s) => s.text).join('');
        assert.equal(rebuilt, text, `lost text for ${JSON.stringify({ text, query })}`);
      }
    }
  });

  test('start offsets are unique and locate the segment in the source', () => {
    // The renderer keys on `start`, so a duplicate would collapse two segments
    // into one React node and drop text from the page.
    const text = 'the cat sat on the mat';
    const segments = segmentByMatches(text, 'at');
    const starts = segments.map((s) => s.start);
    assert.equal(new Set(starts).size, starts.length, 'duplicate start offset');
    for (const segment of segments) {
      assert.equal(text.slice(segment.start, segment.start + segment.text.length), segment.text);
    }
  });

  test('marked segments are exactly the matches', () => {
    const text = 'cat CAT Cat';
    const marked = segmentByMatches(text, 'cat').filter((s) => s.match);
    assert.equal(marked.length, 3);
    for (const segment of marked) {
      assert.equal(segment.text.toLowerCase(), 'cat');
    }
  });
});
