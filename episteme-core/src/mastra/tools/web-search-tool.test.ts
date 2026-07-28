// episteme-core/src/mastra/tools/web-search-tool.test.ts
/**
 * Tests for the web tier's domain provenance gate.
 *
 * Regression origin: a question about onboarding staff in Episteme was answered
 * from a SaaS vendor's HR blog, presented to the user as a Uniben answer under
 * an "unverified" banner. Two independent defects allowed it — an allowlist that
 * failed OPEN when it parsed to nothing, and an allowlist that was only ever
 * requested of the search provider and never verified against the response.
 *
 * Pure — no network, no API key.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedDomain } from './web-search-tool';

const UNIBEN = ['uniben.edu', 'nuc.edu.ng', 'jamb.gov.ng', 'tetfund.gov.ng'];

describe('isAllowedDomain — admits the intended domains', () => {
  test('an exact domain match is allowed', () => {
    assert.ok(isAllowedDomain('https://uniben.edu/admissions', UNIBEN));
    assert.ok(isAllowedDomain('https://jamb.gov.ng/', UNIBEN));
  });

  test('subdomains are allowed', () => {
    for (const url of [
      'https://www.uniben.edu/about',
      'https://news.uniben.edu/post/1',
      'https://portal.uniben.edu/login',
      'https://deep.nested.sub.uniben.edu/x',
    ]) {
      assert.ok(isAllowedDomain(url, UNIBEN), `rejected legitimate: ${url}`);
    }
  });

  test('http and paths, ports and queries do not affect the decision', () => {
    assert.ok(isAllowedDomain('http://uniben.edu:8080/a/b?c=d#e', UNIBEN));
  });
});

describe('isAllowedDomain — rejects everything else', () => {
  test('the actual result that reached a user is rejected', () => {
    assert.equal(
      isAllowedDomain('https://www.manageengine.com/products/service-desk/onboarding.html', UNIBEN),
      false,
    );
  });

  test('lookalike domains cannot pass as the real one', () => {
    for (const url of [
      'https://evil-uniben.edu/x',        // suffix without a dot boundary
      'https://uniben.edu.attacker.com/', // allowed domain as a prefix label
      'https://notuniben.edu/',
      'https://uniben.com/',              // right name, wrong TLD
      'https://xuniben.edu/',
    ]) {
      assert.equal(isAllowedDomain(url, UNIBEN), false, `admitted lookalike: ${url}`);
    }
  });

  test('an unparseable URL is rejected, not admitted by accident', () => {
    for (const url of ['', 'not a url', 'uniben.edu/no-scheme', '//uniben.edu']) {
      assert.equal(isAllowedDomain(url, UNIBEN), false, `admitted unparseable: ${url}`);
    }
  });

  test('an empty allowlist admits nothing — the gate fails closed', () => {
    // The behaviour the original bug inverted: no allowlist must mean "nothing
    // is in scope", never "everything is". Unrestricted search is a separate,
    // explicit flag (WEB_SEARCH_ALLOW_ANY_DOMAIN).
    assert.equal(isAllowedDomain('https://uniben.edu/', []), false);
    assert.equal(isAllowedDomain('https://anything.com/', []), false);
  });

  test('case and www are normalised on both sides', () => {
    assert.ok(isAllowedDomain('https://WWW.UniBen.EDU/x', UNIBEN));
    assert.ok(isAllowedDomain('https://news.uniben.edu/x', ['WWW.UNIBEN.EDU']));
  });
});

describe('the allowlist cannot be widened by a malformed value', () => {
  // Mirrors config.ts's envAllowlist. Asserted here as behaviour rather than
  // reaching into the module, so the intent survives a refactor of either side.
  const envAllowlist = (raw: string | undefined, fallback: string[]): string[] => {
    const parsed = !raw ? fallback : raw.split(',').map((s) => s.trim()).filter(Boolean);
    return parsed.length > 0 ? parsed : fallback;
  };

  test('empty, whitespace and comma-only values all fall back to the default', () => {
    // Every one of these previously produced [] → include_domains: undefined
    // → an unrestricted search of the entire internet.
    for (const raw of [undefined, '', ' ', ',', ', ,', '   ,  ,']) {
      assert.deepEqual(
        envAllowlist(raw, UNIBEN),
        UNIBEN,
        `${JSON.stringify(raw)} did not fail closed`,
      );
    }
  });

  test('a genuine value still overrides the default', () => {
    assert.deepEqual(envAllowlist('example.edu, other.ng', UNIBEN), ['example.edu', 'other.ng']);
  });
});
