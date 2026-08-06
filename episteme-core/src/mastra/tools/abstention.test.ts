// tools/abstention.test.ts
//
// The abstention branch is where a whole CATEGORY of real question lands. The
// corpus is a student handbook, so records questions — fees, registration,
// transcripts, CGPA — retrieve nothing at all (see KB_UNLABELLED), and those are
// among the most-asked. What this text says is what many users actually read.
//
// Every assertion here is about not inventing: the options offered must come
// from documents that exist, and no contact destination may be conjured.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { labelForSource, type ReachableSource } from './corpus-manifest';
import { buildAbstentionAnswer } from './abstention';

const src = (source: string, namespace = 'general'): ReachableSource => ({
  source,
  label: labelForSource(source),
  namespace,
});

describe('labelForSource', () => {
  test('strips scheme, path and extension without coining a title', () => {
    assert.equal(labelForSource('https://uniben.edu/STUDENTHANDBOOK.pdf'), 'STUDENTHANDBOOK');
    assert.equal(labelForSource('https://www.uniben.edu/admission_policy.html'), 'admission policy');
    assert.equal(
      labelForSource('https://uniben.edu/documents/ACADEMIC_CALENDAR_PG_2026.pdf'),
      'ACADEMIC CALENDAR PG 2026',
    );
  });

  test('does not expand or prettify a name', () => {
    // "STUDENTHANDBOOK" must NOT become "Student Handbook". Splitting a run of
    // capitals is a guess about what the document is called, and guessing names
    // is the exact failure this path exists to remove.
    assert.equal(labelForSource('STUDENTHANDBOOK.pdf'), 'STUDENTHANDBOOK');
  });

  test('drops query strings and fragments', () => {
    assert.equal(labelForSource('https://uniben.edu/policy.html?v=2#part3'), 'policy');
  });

  test('never returns empty, whatever it is handed', () => {
    for (const input of ['', '/', 'https://uniben.edu/', '.pdf']) {
      assert.ok(labelForSource(input).length > 0 || input === '', `empty label for ${JSON.stringify(input)}`);
    }
  });
});

describe('abstention payload — with documents available', () => {
  const answer = buildAbstentionAnswer('what are the school fees', [
    src('https://uniben.edu/STUDENTHANDBOOK.pdf'),
    src('https://www.uniben.edu/admission_policy.html', 'admissions'),
  ]);

  test('signals no results', () => {
    assert.match(answer, /^NO_RESULTS:/);
  });

  test('lists every reachable document, and says the list is complete', () => {
    assert.match(answer, /STUDENTHANDBOOK/);
    assert.match(answer, /admission policy/);
    assert.match(answer, /there is nothing else/i);
  });

  test('forbids offering options outside the list', () => {
    // Without this, the model rewords the user's own question — the one topic
    // guaranteed to have no source — and the user is refused a second time.
    assert.match(answer, /ONLY from what these documents/i);
    assert.match(answer, /second refusal/i);
  });

  test('forbids describing document contents it has not seen', () => {
    assert.match(answer, /their existence, not their contents/i);
  });
});

describe('abstention payload — nothing available', () => {
  const answer = buildAbstentionAnswer('what are the school fees', []);

  test('tells the model to offer nothing rather than guess', () => {
    assert.match(answer, /Do NOT offer alternative angles/);
    assert.match(answer, /every option\s*\n?would dead-end|dead-end/i);
  });

  test('does not present an empty list as if it were a list', () => {
    assert.doesNotMatch(answer, /DOCUMENTS THIS USER CAN READ/);
  });
});

describe('escalation destination', () => {
  for (const reachable of [[], [src('https://uniben.edu/STUDENTHANDBOOK.pdf')]]) {
    const label = reachable.length ? 'with documents' : 'with none';

    test(`names only the verified destination (${label})`, () => {
      const answer = buildAbstentionAnswer('anything', reachable);
      assert.match(answer, /https:\/\/uniben\.edu/);
    });

    test(`forbids inventing an office or contact detail (${label})`, () => {
      const answer = buildAbstentionAnswer('anything', reachable);
      assert.match(answer, /Do NOT name a specific office/i);
      assert.match(answer, /email address or\s*\n?phone number/i);
    });

    test(`names no office of its own (${label})`, () => {
      const answer = buildAbstentionAnswer('anything', reachable);
      // The payload must not itself supply the very thing it forbids. These are
      // the offices the model previously conjured unprompted.
      for (const office of ['Registry', 'Bursary', 'Student Affairs', 'Admissions Office']) {
        assert.doesNotMatch(
          answer,
          new RegExp(`\\b${office}\\b`),
          `abstention payload names "${office}" — the instruction forbids exactly this`,
        );
      }
    });
  }
});
