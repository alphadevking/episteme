// lib/harvest/robots.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobotsTxt, isAllowed, robotsPath } from './robots';

const UA = 'EpistemeHarvester';
const allowed = (text: string, path: string, ua = UA) =>
  isAllowed(parseRobotsTxt(text, ua), path);

describe('parseRobotsTxt — group selection', () => {
  test('falls back to the wildcard group', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /private/', UA);
    assert.equal(robots.matched, true);
    assert.equal(robots.rules.length, 1);
  });

  test('a named group beats the wildcard', () => {
    const text = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: EpistemeHarvester',
      'Disallow: /private/',
    ].join('\n');
    // If the wildcard had won, everything would be blocked.
    assert.equal(allowed(text, '/departments/'), true);
    assert.equal(allowed(text, '/private/x'), false);
  });

  test('consecutive User-agent lines share one rule block', () => {
    const text = [
      'User-agent: GoogleBot',
      'User-agent: EpistemeHarvester',
      'Disallow: /secret/',
    ].join('\n');
    assert.equal(allowed(text, '/secret/a'), false);
    assert.equal(allowed(text, '/public/a'), true);
  });

  test('matching is case-insensitive', () => {
    const text = 'User-agent: epistemeharvester\nDisallow: /x/';
    assert.equal(allowed(text, '/x/1'), false);
  });

  test('reports no match when no group applies', () => {
    const robots = parseRobotsTxt('User-agent: GoogleBot\nDisallow: /', UA);
    assert.equal(robots.matched, false);
    assert.equal(isAllowed(robots, '/anything'), true);
  });
});

describe('parseRobotsTxt — directives', () => {
  test('ignores comments and blank lines', () => {
    const text = '# a comment\n\nUser-agent: *   # trailing\nDisallow: /a/  # here too\n';
    assert.equal(allowed(text, '/a/1'), false);
    assert.equal(allowed(text, '/b/1'), true);
  });

  test('an empty Disallow means allow everything', () => {
    // "Disallow:" with no value is the standard's way of saying "no
    // restrictions" — reading it as a rule matching "" would block the site.
    assert.equal(allowed('User-agent: *\nDisallow:', '/anything'), true);
  });

  test('reads Crawl-delay', () => {
    const robots = parseRobotsTxt('User-agent: *\nCrawl-delay: 10', UA);
    assert.equal(robots.crawlDelay, 10);
  });

  test('an empty file allows everything', () => {
    assert.equal(allowed('', '/anything'), true);
  });
});

describe('isAllowed — precedence', () => {
  test('the longest matching pattern wins', () => {
    const text = 'User-agent: *\nDisallow: /docs/\nAllow: /docs/public/';
    assert.equal(allowed(text, '/docs/private/x'), false);
    assert.equal(allowed(text, '/docs/public/x'), true);
  });

  test('Allow wins an equal-length tie', () => {
    const text = 'User-agent: *\nDisallow: /a\nAllow: /a';
    assert.equal(allowed(text, '/a'), true);
  });

  test('a wildcard in the middle of a pattern', () => {
    const text = 'User-agent: *\nDisallow: /*/private/';
    assert.equal(allowed(text, '/faculty/private/x'), false);
    assert.equal(allowed(text, '/faculty/public/x'), true);
  });

  test('$ anchors the end', () => {
    const text = 'User-agent: *\nDisallow: /*.pdf$';
    assert.equal(allowed(text, '/docs/handbook.pdf'), false);
    assert.equal(allowed(text, '/docs/handbook.pdf.html'), true);
  });

  test('a bare Disallow: / blocks the whole site', () => {
    assert.equal(allowed('User-agent: *\nDisallow: /', '/'), false);
    assert.equal(allowed('User-agent: *\nDisallow: /', '/anything/deep'), false);
  });

  test('regex metacharacters in a path are literal', () => {
    // A pattern containing '.' or '+' must not match arbitrary characters.
    const text = 'User-agent: *\nDisallow: /a.b/';
    assert.equal(allowed(text, '/a.b/x'), false);
    assert.equal(allowed(text, '/axb/x'), true);
  });
});

describe('robotsPath', () => {
  test('includes the query string', () => {
    assert.equal(robotsPath('https://uniben.edu/a/b?x=1'), '/a/b?x=1');
  });

  test('drops the fragment', () => {
    assert.equal(robotsPath('https://uniben.edu/a#top'), '/a');
  });

  test('a bare origin is /', () => {
    assert.equal(robotsPath('https://uniben.edu'), '/');
  });
});
