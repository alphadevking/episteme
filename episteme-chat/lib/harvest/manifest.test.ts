// lib/harvest/manifest.test.ts
/**
 * The manifest grants read access to real people, so the things worth testing
 * are the ones that would go wrong quietly: a docId collision overwriting a
 * page's vectors, a scope typo widening access, a PDF on a path that turns it
 * into noise. None of these fail loudly at ingest time.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST,
  validateManifest,
  docIdFromUrl,
  toIngestBody,
  NAMESPACES,
  ROLES,
  type HarvestEntry,
} from './manifest';

const base: HarvestEntry = {
  url: 'https://physci.uniben.edu/example/',
  source: 'Example',
  namespace: 'general',
  category: 'general',
  roles: ['student'],
  faculty: 'physical-sciences',
  contentType: 'general',
  updatedAt: null,
};

describe('the shipped manifest', () => {
  test('is valid', () => {
    assert.deepEqual(validateManifest(), []);
  });

  test('is not empty', () => {
    assert.ok(MANIFEST.length > 0);
  });

  test('every docId is unique', () => {
    const ids = MANIFEST.map((e) => docIdFromUrl(e.url));
    assert.equal(new Set(ids).size, ids.length, 'a duplicate docId would overwrite another page');
  });

  test('no entry is staff-internal without a staff role', () => {
    // The inverse of the usual worry: a document filed in staff-internal but
    // readable by students is a leak; one readable by nobody is dead weight.
    for (const entry of MANIFEST.filter((e) => e.namespace === 'staff-internal')) {
      assert.ok(
        entry.roles.some((r) => r === 'staff' || r === 'hod'),
        `${entry.url} is staff-internal but grants no staff role`,
      );
    }
  });

  test('no public-facing page is scoped to staff only', () => {
    for (const entry of MANIFEST.filter((e) => e.namespace === 'admissions')) {
      assert.ok(
        entry.roles.includes('prospective'),
        `${entry.url} is admissions material that prospective students cannot see`,
      );
    }
  });

  test('every entry declares its content date deliberately', () => {
    // null is a valid, meaningful value here. What must not happen is a date
    // that is not a date, or a stamped "today" standing in for unknown.
    for (const entry of MANIFEST) {
      if (entry.updatedAt === null) continue;
      assert.ok(!Number.isNaN(Date.parse(entry.updatedAt)), `${entry.url}: bad updatedAt`);
    }
  });
});

describe('docIdFromUrl', () => {
  test('is stable across trailing-slash and www differences', () => {
    assert.equal(
      docIdFromUrl('https://www.uniben.edu/policies.html'),
      docIdFromUrl('https://uniben.edu/policies.html'),
    );
  });

  test('distinguishes pages that differ only by path', () => {
    assert.notEqual(
      docIdFromUrl('https://physci.uniben.edu/department-of-chemistry/'),
      docIdFromUrl('https://physci.uniben.edu/department-of-chemistry-courses/'),
    );
  });

  test('distinguishes the same path on different subdomains', () => {
    assert.notEqual(
      docIdFromUrl('https://physci.uniben.edu/departments/'),
      docIdFromUrl('https://eng.uniben.edu/departments/'),
    );
  });

  test('handles a bare host', () => {
    assert.ok(docIdFromUrl('https://physci.uniben.edu/').length > 0);
  });
});

describe('validateManifest catches what fails quietly', () => {
  test('a docId collision', () => {
    const problems = validateManifest([
      { ...base, url: 'https://physci.uniben.edu/a/' },
      // Different URL, same derived id — the second would replace the first.
      { ...base, url: 'https://physci.uniben.edu/a' },
    ]);
    assert.ok(problems.some((p) => /collides/.test(p.problem)), JSON.stringify(problems));
  });

  test('a non-uniben host', () => {
    const problems = validateManifest([{ ...base, url: 'https://evil-uniben.edu/page/' }]);
    assert.ok(problems.some((p) => /not uniben\.edu/.test(p.problem)));
  });

  test('a PDF, which the sourceUrl path would corrupt', () => {
    const problems = validateManifest([{ ...base, url: 'https://uniben.edu/STUDENTHANDBOOK.pdf' }]);
    assert.ok(problems.some((p) => /PDFs cannot be harvested by URL/.test(p.problem)));
  });

  test('an unknown role', () => {
    const problems = validateManifest([
      { ...base, roles: ['student', 'admin' as unknown as (typeof ROLES)[number]] },
    ]);
    assert.ok(problems.some((p) => /unknown role/.test(p.problem)));
  });

  test('an empty role list', () => {
    const problems = validateManifest([{ ...base, roles: [] }]);
    assert.ok(problems.some((p) => /no roles/.test(p.problem)));
  });

  test('an unknown namespace', () => {
    const problems = validateManifest([
      { ...base, namespace: 'platform-admin' as unknown as (typeof NAMESPACES)[number] },
    ]);
    assert.ok(problems.some((p) => /unknown namespace/.test(p.problem)));
  });

  test('a garbage content date', () => {
    const problems = validateManifest([{ ...base, updatedAt: 'sometime last year' }]);
    assert.ok(problems.some((p) => /is not a date/.test(p.problem)));
  });

  test('http instead of https', () => {
    const problems = validateManifest([{ ...base, url: 'http://physci.uniben.edu/x/' }]);
    assert.ok(problems.some((p) => /must be https/.test(p.problem)));
  });
});

describe('toIngestBody', () => {
  test('sends updatedAt explicitly, even when null', () => {
    const body = toIngestBody(base, false);
    // Core rejects an ABSENT updatedAt on purpose. Omitting the key here would
    // turn every undated page into a 400 at the far end of a slow harvest.
    assert.ok('updatedAt' in body, 'updatedAt must be present');
    assert.equal(body.updatedAt, null);
  });

  test('omits dryRun entirely for a real ingest', () => {
    assert.equal('dryRun' in toIngestBody(base, false), false);
  });

  test('sets dryRun to boolean true, not a string', () => {
    // Core checks `dryRun === true`. A string would be treated as a real
    // ingest — the exact bug this asserts against.
    assert.strictEqual(toIngestBody(base, true).dryRun, true);
  });

  test('omits optional scopes rather than sending empty ones', () => {
    const body = toIngestBody(base, false);
    assert.equal('programme' in body, false);
    assert.equal('levels' in body, false);
  });

  test('passes the URL through as sourceUrl', () => {
    assert.equal(toIngestBody(base, false).sourceUrl, base.url);
  });
});
