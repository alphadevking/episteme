// lib/harvest/plan.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketSample,
  buildRows,
  canEnter,
  eligibleFor,
  entriesFromUrls,
  parseUrlList,
  sourceLabelFromUrl,
  summarize,
  type AdHocClassification,
  type HarvestRow,
  type RowPhase,
} from './plan';
import { MANIFEST, validateManifest, type HarvestEntry } from './manifest';

const entry = (url: string, namespace: HarvestEntry['namespace'] = 'general'): HarvestEntry => ({
  url,
  source: 'Test',
  namespace,
  category: namespace,
  roles: ['student'],
  faculty: 'general',
  contentType: 'general',
  updatedAt: null,
});

const rowIn = (phase: RowPhase, url = 'https://uniben.edu/a'): HarvestRow => ({
  ...buildRows([entry(url)])[0],
  phase,
});

describe('buildRows', () => {
  test('derives the docId and starts every row queued', () => {
    const rows = buildRows([entry('https://uniben.edu/admissionrequirements.html')]);
    assert.equal(rows[0].phase, 'queued');
    assert.equal(rows[0].docId, 'uniben-main-admissionrequirements');
    assert.equal(rows[0].textLength, null);
    assert.equal(rows[0].report, null);
  });
});

describe('eligibleFor — validation', () => {
  test('picks up queued, failed, and skipped rows', () => {
    const rows = [rowIn('queued', 'https://uniben.edu/a'), rowIn('failed', 'https://uniben.edu/b'), rowIn('skipped', 'https://uniben.edu/c')];
    assert.equal(eligibleFor(rows, 'validate').length, 3);
  });

  test('leaves an already-previewed row alone', () => {
    // Re-running validate must not knock a previewed row back to `validated`
    // and silently discard its report.
    assert.equal(canEnter('validate', 'previewed'), false);
    assert.equal(canEnter('validate', 'validated'), false);
  });

  test('never re-touches a committed row', () => {
    const rows = [rowIn('committed')];
    assert.equal(eligibleFor(rows, 'validate').length, 0);
    assert.equal(eligibleFor(rows, 'preview').length, 0);
    assert.equal(eligibleFor(rows, 'commit').length, 0);
  });

  test('a row in flight is eligible for nothing', () => {
    for (const phase of ['validating', 'previewing', 'committing'] as RowPhase[]) {
      assert.equal(canEnter('validate', phase), false, phase);
      assert.equal(canEnter('preview', phase), false, phase);
      assert.equal(canEnter('commit', phase), false, phase);
    }
  });
});

describe('eligibleFor — preview and commit require validation', () => {
  // This is the one deliberate difference from the CLI, which re-derives
  // everything per invocation and will happily commit a page whose fetch
  // failed minutes earlier. Nothing unvalidated may reach an Unstructured call
  // or a write.
  for (const phase of ['queued', 'failed', 'skipped'] as RowPhase[]) {
    test(`a ${phase} row cannot be previewed or committed`, () => {
      assert.equal(canEnter('preview', phase), false);
      assert.equal(canEnter('commit', phase), false);
    });
  }

  test('a validated row may be previewed or committed directly', () => {
    assert.equal(canEnter('preview', 'validated'), true);
    assert.equal(canEnter('commit', 'validated'), true);
  });

  test('a previewed row may be committed, or previewed again', () => {
    assert.equal(canEnter('commit', 'previewed'), true);
    assert.equal(canEnter('preview', 'previewed'), true);
  });
});

describe('bucketSample', () => {
  test('keeps one page per host and namespace', () => {
    const entries = [
      entry('https://physci.uniben.edu/a', 'programmes'),
      entry('https://physci.uniben.edu/b', 'programmes'),
      entry('https://physci.uniben.edu/c', 'academic-policy'),
      entry('https://uniben.edu/d', 'programmes'),
    ];
    const sample = bucketSample(entries, (e) => e);
    assert.deepEqual(sample.map((e) => e.url), [
      'https://physci.uniben.edu/a',
      'https://physci.uniben.edu/c',
      'https://uniben.edu/d',
    ]);
  });

  test('keeps the first of each bucket, not an arbitrary one', () => {
    const entries = [entry('https://uniben.edu/first'), entry('https://uniben.edu/second')];
    assert.equal(bucketSample(entries, (e) => e)[0].url, 'https://uniben.edu/first');
  });

  test('samples rows and entries identically', () => {
    // The whole point of the shared function: the sample the UI previews is
    // provably the sample the CLI would have previewed.
    const entries = [
      entry('https://physci.uniben.edu/a', 'programmes'),
      entry('https://physci.uniben.edu/b', 'programmes'),
      entry('https://uniben.edu/c', 'general'),
    ];
    const fromEntries = bucketSample(entries, (e) => e).map((e) => e.url);
    const fromRows = bucketSample(buildRows(entries), (r) => r.entry).map((r) => r.entry.url);
    assert.deepEqual(fromRows, fromEntries);
  });

  test('the real manifest samples down to a handful', () => {
    const sample = bucketSample(MANIFEST, (e) => e);
    assert.ok(sample.length > 0);
    assert.ok(sample.length < MANIFEST.length, 'sampling should cost less than previewing everything');
  });
});

describe('summarize', () => {
  test('counts each phase and reports whether anything is running', () => {
    const rows = [rowIn('committed', 'https://uniben.edu/a'), rowIn('failed', 'https://uniben.edu/b'), rowIn('queued', 'https://uniben.edu/c')];
    const summary = summarize(rows);
    assert.equal(summary.total, 3);
    assert.equal(summary.committed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.queued, 1);
    assert.equal(summary.running, false);
  });

  test('a single in-flight row marks the run as running', () => {
    assert.equal(summarize([rowIn('queued', 'https://uniben.edu/a'), rowIn('committing', 'https://uniben.edu/b')]).running, true);
  });
});

describe('parseUrlList', () => {
  test('reads one URL per line, ignoring blanks and comments', () => {
    const { urls, problems } = parseUrlList(
      ['# the pilot faculty', 'https://uniben.edu/a', '', '  https://uniben.edu/b  ', 'https://uniben.edu/c # inline note'].join('\n'),
    );
    assert.deepEqual(urls, ['https://uniben.edu/a', 'https://uniben.edu/b', 'https://uniben.edu/c']);
    assert.deepEqual(problems, []);
  });

  test('reports a repeated URL instead of harvesting it twice', () => {
    const { urls, problems } = parseUrlList('https://uniben.edu/a\nhttps://uniben.edu/a');
    assert.deepEqual(urls, ['https://uniben.edu/a']);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /more than once/);
  });

  test('does not judge whether a URL is permitted — that is validateManifest', () => {
    const { urls, problems } = parseUrlList('https://example.com/evil');
    assert.deepEqual(urls, ['https://example.com/evil']);
    assert.deepEqual(problems, []);
  });
});

describe('entriesFromUrls', () => {
  const classification: AdHocClassification = {
    namespace: 'admissions',
    category: 'admissions',
    roles: ['prospective', 'parent'],
    faculty: 'general',
    contentType: 'policy',
    updatedAt: null,
  };

  test('applies the shared classification to every URL', () => {
    const entries = entriesFromUrls(['https://uniben.edu/a.html', 'https://uniben.edu/b.html'], classification);
    assert.equal(entries.length, 2);
    for (const e of entries) {
      assert.equal(e.namespace, 'admissions');
      assert.deepEqual(e.roles, ['prospective', 'parent']);
      assert.equal(e.updatedAt, null);
    }
  });

  test('copies the roles array rather than sharing it', () => {
    // A shared reference would let editing one row's roles silently widen
    // access on every other row in the batch.
    const entries = entriesFromUrls(['https://uniben.edu/a', 'https://uniben.edu/b'], classification);
    entries[0].roles.push('hod');
    assert.deepEqual(entries[1].roles, ['prospective', 'parent']);
    assert.deepEqual(classification.roles, ['prospective', 'parent']);
  });

  test('produces entries the manifest validator accepts', () => {
    const problems = validateManifest(
      entriesFromUrls(['https://uniben.edu/a.html', 'https://physci.uniben.edu/b/'], classification),
    );
    assert.deepEqual(problems, []);
  });

  test('the validator still rejects a bad ad-hoc URL', () => {
    // Ad-hoc entry creation must not be a way around the manifest's rules.
    const problems = validateManifest(entriesFromUrls(['https://example.com/x', 'http://uniben.edu/y.pdf'], classification));
    assert.ok(problems.some((p) => /not uniben\.edu/.test(p.problem)));
    assert.ok(problems.some((p) => /PDFs cannot be harvested/.test(p.problem)));
    assert.ok(problems.some((p) => /must be https/.test(p.problem)));
  });
});

describe('sourceLabelFromUrl', () => {
  test('builds a readable label from host and last path segment', () => {
    assert.equal(sourceLabelFromUrl('https://uniben.edu/admissionrequirements.html'), 'uniben.edu — Admissionrequirements');
    assert.equal(
      sourceLabelFromUrl('https://physci.uniben.edu/academics-departments/'),
      'physci.uniben.edu — Academics Departments',
    );
  });

  test('falls back to the host for a root URL', () => {
    assert.equal(sourceLabelFromUrl('https://physci.uniben.edu/'), 'physci.uniben.edu');
  });

  test('drops the www prefix', () => {
    assert.equal(sourceLabelFromUrl('https://www.uniben.edu/'), 'uniben.edu');
  });

  test('returns the input unchanged when it is not a URL', () => {
    assert.equal(sourceLabelFromUrl('nonsense'), 'nonsense');
  });

  test('never returns an empty label', () => {
    // An empty source means a blank citation, which validateManifest rejects.
    for (const url of ['https://uniben.edu/', 'https://uniben.edu/---/', 'https://uniben.edu/.html']) {
      assert.ok(sourceLabelFromUrl(url).trim().length > 0, url);
    }
  });
});
