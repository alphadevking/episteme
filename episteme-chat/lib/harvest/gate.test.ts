// lib/harvest/gate.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DELAY_MS,
  THIN_TEXT_CHARS,
  groupByOrigin,
  isThin,
  originOf,
  textLengthOf,
  verdictFor,
} from './gate';
import { parseRobotsTxt } from './robots';

const UA = 'EpistemeHarvester';
const robots = (text: string) => parseRobotsTxt(text, UA);

describe('verdictFor — fail closed', () => {
  test('an unreadable robots.txt refuses the page', () => {
    const verdict = verdictFor(null, 'https://uniben.edu/anything.html');
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason ?? '', /could not be read/);
  });

  test('an unreadable robots.txt still returns a usable delay', () => {
    // The caller paces on this value even while skipping, so it must never be
    // undefined or NaN.
    assert.equal(verdictFor(null, 'https://uniben.edu/x').delayMs, DEFAULT_DELAY_MS);
  });

  test('an empty robots.txt permits everything', () => {
    // Distinct from unreadable: a file that exists and declares no rules is a
    // deliberate "no restrictions", not an absence of information.
    const verdict = verdictFor(robots(''), 'https://uniben.edu/x');
    assert.equal(verdict.allowed, true);
  });

  test('a Disallow blocks the matching path and nothing else', () => {
    const parsed = robots('User-agent: *\nDisallow: /private/');
    assert.equal(verdictFor(parsed, 'https://uniben.edu/private/a').allowed, false);
    assert.equal(verdictFor(parsed, 'https://uniben.edu/public/a').allowed, true);
  });

  test('the query string is part of the matched path', () => {
    const parsed = robots('User-agent: *\nDisallow: /*?print=');
    assert.equal(verdictFor(parsed, 'https://uniben.edu/page?print=1').allowed, false);
    assert.equal(verdictFor(parsed, 'https://uniben.edu/page').allowed, true);
  });
});

describe('verdictFor — pacing', () => {
  test('a declared Crawl-delay raises the floor', () => {
    const parsed = robots('User-agent: *\nCrawl-delay: 10');
    assert.equal(verdictFor(parsed, 'https://uniben.edu/x').delayMs, 10_000);
  });

  test('a Crawl-delay below our own floor does not lower it', () => {
    // Being told we may go faster is not a reason to.
    const parsed = robots('User-agent: *\nCrawl-delay: 0.1');
    assert.equal(verdictFor(parsed, 'https://uniben.edu/x').delayMs, DEFAULT_DELAY_MS);
  });

  test('a refused page still reports the origin delay', () => {
    const parsed = robots('User-agent: *\nDisallow: /\nCrawl-delay: 5');
    const verdict = verdictFor(parsed, 'https://uniben.edu/x');
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.delayMs, 5_000);
  });
});

describe('groupByOrigin', () => {
  test('buckets by origin and preserves order within a bucket', () => {
    const groups = groupByOrigin([
      'https://uniben.edu/a',
      'https://physci.uniben.edu/b',
      'https://uniben.edu/c',
    ]);
    assert.deepEqual([...groups.keys()], ['https://uniben.edu', 'https://physci.uniben.edu']);
    assert.deepEqual(groups.get('https://uniben.edu'), ['https://uniben.edu/a', 'https://uniben.edu/c']);
  });

  test('scheme and port are part of the origin', () => {
    const groups = groupByOrigin(['https://uniben.edu/a', 'http://uniben.edu/b']);
    assert.equal(groups.size, 2);
  });

  test('unparseable URLs are dropped rather than crashing the batch', () => {
    const groups = groupByOrigin(['not a url', 'https://uniben.edu/a']);
    assert.equal(groups.size, 1);
    assert.deepEqual(groups.get('https://uniben.edu'), ['https://uniben.edu/a']);
  });
});

describe('textLengthOf', () => {
  test('measures visible text, not markup', () => {
    // The failure this guards: 40 KB of markup wrapping two sentences reads as
    // a healthy fetch by byte count.
    const html = `<div class="${'x'.repeat(500)}"><p>Hello world</p></div>`;
    assert.equal(textLengthOf(html), 'Hello world'.length);
  });

  test('collapses whitespace between elements', () => {
    assert.equal(textLengthOf('<p>a</p>\n\n   <p>b</p>'), 'a b'.length);
  });

  test('a page of pure markup measures zero', () => {
    assert.equal(textLengthOf('<div><span></span></div>'), 0);
  });
});

describe('isThin', () => {
  test('the boundary itself is not thin', () => {
    assert.equal(isThin(THIN_TEXT_CHARS), false);
    assert.equal(isThin(THIN_TEXT_CHARS - 1), true);
  });
});

describe('originOf', () => {
  test('strips path, query, and fragment', () => {
    assert.equal(originOf('https://physci.uniben.edu/courses/?x=1#top'), 'https://physci.uniben.edu');
  });
});
