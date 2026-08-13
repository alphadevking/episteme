// tools/grounded-context.test.ts
//
// THE INCIDENT THIS FILE EXISTS FOR. The agent once answered "who is the Vice
// Chancellor" with a 2022 handbook's former office holder while a current
// principal-staff source sat beside it in the very same context. The fix was an
// instruction: when sources disagree on a fact that changes over time, state
// ONLY the value from the most recently dated source.
//
// That instruction is load-bearing and, until this file, entirely untested.
//
// The rule has two halves. Whether the MODEL OBEYS a correctly-formed context
// needs a live model and belongs in the prompt evals. Whether the context is
// correctly formed is pure, and it is the half that can break in silence: drop a
// date tag, mislabel a dated source as undated, or quietly stop emitting the
// conflict paragraph, and the model loses the ability to choose correctly while
// the answer still reads perfectly well. Nothing else in the suite would notice.
//
// Dates are asserted by YEAR rather than by full formatted string: the builder
// uses toLocaleDateString, so pinning "12 March 2022" would fail in any timezone
// that shifts the day, testing the test runner's clock instead of the code.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGroundedContext, deriveTitle } from './grounded-context';
import type {
  KnowledgeRetrievalResponse,
  KnowledgeRetrievalResult,
} from './knowledge-retrieval-tool';

const HANDBOOK = 'https://uniben.edu/STUDENTHANDBOOK.pdf';
const OFFICERS = 'https://uniben.edu/principal-officers.html';

function chunk(over: Partial<KnowledgeRetrievalResult> = {}): KnowledgeRetrievalResult {
  return {
    chunkId: 'chunk-1',
    content: 'Some retrieved passage.',
    source: HANDBOOK,
    updatedAt: null,
    staleWarning: null,
    pageNumber: null,
    ...over,
  };
}

function found(results: KnowledgeRetrievalResult[]): KnowledgeRetrievalResponse & { found: true } {
  return { found: true, results, maxScore: 0.82, judgedBy: 'rerank' };
}

/**
 * Collapses the builder's hard-wrapped lines so an assertion can quote a whole
 * sentence. The wrapping is a source-formatting choice and must not be what a
 * test is pinned to — rewrapping a paragraph should not fail the suite.
 */
const flat = (context: string) => context.replace(/\s+/g, ' ');
const flatten = (built: { context: string }) => ({ context: flat(built.context) });

describe('buildGroundedContext — the conflict rule is actually present', () => {
  test('the disagreement instruction is emitted', () => {
    const { context } = buildGroundedContext(found([chunk()]));
    assert.match(context, /DISAGREE/);
    assert.match(context, /most recently dated source/i);
  });

  test('it forbids presenting an older value alongside the newer one', () => {
    // "Cite both and let the reader decide" is the tempting wrong behaviour and
    // exactly what produced the incident. The instruction must rule it out.
    const { context } = flatten(buildGroundedContext(found([chunk()])));
    assert.match(context, /Never present an older source's value as current/i);
    assert.match(context, /not even alongside the newer one/i);
  });

  test('a dated source is declared to beat an undated one regardless of order', () => {
    const { context } = flatten(buildGroundedContext(found([chunk()])));
    assert.match(context, /DATED source beats an undated one/i);
    assert.match(context, /whatever order they appear in below/i);
  });

  test('citations are requested in the [N](cite:N) form the client resolves', () => {
    const { context } = buildGroundedContext(found([chunk()]));
    assert.match(context, /\[N\]\(cite:N\)/);
  });

  test('the model is told not to restate the source list', () => {
    // The client renders sources from the structured array. Prose duplication is
    // the format violation seen repeatedly in the prompt evals.
    const { context } = flatten(buildGroundedContext(found([chunk()])));
    assert.match(context, /do not add a ## Sources section/i);
    assert.match(context, /do not paste any URL/i);
  });
});

describe('buildGroundedContext — date labelling, which the rule depends on', () => {
  test('a dated source carries its year, not a raw ISO timestamp', () => {
    const { context } = buildGroundedContext(found([
      chunk({ updatedAt: '2022-03-12T12:00:00.000Z' }),
    ]));
    assert.match(context, /dated .*2022/);
    assert.ok(
      !context.includes('2022-03-12T12:00:00.000Z'),
      'the ISO string leaked instead of being formatted for the model',
    );
  });

  test('an undated source is labelled undated, never given a fabricated date', () => {
    const { context } = buildGroundedContext(found([chunk({ updatedAt: null })]));
    assert.match(context, /\[Source 1 — undated\]/);
  });

  test('an undated source is NOT marked as outdated', () => {
    // Asserting something "may be outdated" is a claim about its age, and an
    // undated source gives us none. Conflating the two would have the model
    // hedge against a document that might be this morning's.
    const { context } = buildGroundedContext(found([chunk({ updatedAt: null })]));
    assert.ok(!context.includes('may be outdated'));
    assert.match(flat(context), /its age is unknown, which is not the same as being old/i);
  });

  test('a stale source is tagged on its own block and triggers the caveat', () => {
    const { context } = buildGroundedContext(found([
      chunk({ updatedAt: '2019-01-15T12:00:00.000Z', staleWarning: 'older than threshold' }),
    ]));
    assert.match(context, /\[Source 1 — dated .*2019 — may be outdated\]/);
    assert.match(context, /may only be used for facts no fresher source covers/i);
  });

  test('the stale caveat is absent when nothing is stale', () => {
    const { context } = buildGroundedContext(found([
      chunk({ updatedAt: '2026-02-01T12:00:00.000Z' }),
    ]));
    assert.ok(!context.includes('may be outdated'));
  });

  test('the undated caveat is absent when every source is dated', () => {
    // NOT asserted as "the word undated is absent": the always-present conflict
    // rule says "a DATED source beats an undated one", so the word is there
    // legitimately. Only the conditional guidance paragraph should be missing.
    const { context } = buildGroundedContext(found([
      chunk({ updatedAt: '2026-02-01T12:00:00.000Z' }),
    ]));
    assert.ok(!context.includes('its age is unknown'));
    assert.ok(!context.includes('[Source 1 — undated]'));
  });
});

describe('buildGroundedContext — the VC incident, encoded', () => {
  // The exact shape that went wrong: the same time-varying fact in a stale
  // handbook and in a current officers page, retrieved together, with the STALE
  // ONE FIRST so ordering cannot rescue the answer.
  const incident = found([
    chunk({
      chunkId: 'handbook-vc',
      source: HANDBOOK,
      content: 'The Vice Chancellor is Professor A. Former.',
      updatedAt: '2022-06-01T12:00:00.000Z',
      staleWarning: 'older than threshold',
      pageNumber: 4,
    }),
    chunk({
      chunkId: 'officers-vc',
      source: OFFICERS,
      content: 'The Vice Chancellor is Professor B. Current.',
      updatedAt: '2026-05-20T12:00:00.000Z',
    }),
  ]);

  test('both sources reach the model with distinguishable dates', () => {
    // The model cannot prefer the newer source if both arrive looking the same.
    const { context } = buildGroundedContext(incident);
    assert.match(context, /\[Source 1 — dated .*2022 — may be outdated\]/);
    assert.match(context, /\[Source 2 — dated .*2026\]/);
  });

  test('the stale source is marked and the fresh one is not', () => {
    const { context } = buildGroundedContext(incident);
    const staleTags = context.match(/may be outdated\]/g) ?? [];
    assert.equal(staleTags.length, 1, 'exactly one source block should be tagged stale');
  });

  test('the conflict instruction accompanies the conflicting sources', () => {
    const { context } = buildGroundedContext(incident);
    assert.match(context, /DISAGREE on a fact that changes over time/i);
    assert.match(context, /who holds an office/i);
  });

  test('both sources are citable, so the model can attribute the value it picks', () => {
    const { sources } = buildGroundedContext(incident);
    assert.deepEqual(sources.map((s) => s.number), [1, 2]);
    assert.equal(sources[1]!.url, OFFICERS);
  });
});

describe('buildGroundedContext — source numbering', () => {
  test('several chunks from one document share a single citation number', () => {
    const { context, sources } = buildGroundedContext(found([
      chunk({ chunkId: 'a', pageNumber: 3 }),
      chunk({ chunkId: 'b', pageNumber: 7 }),
    ]));
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.number, 1);
    assert.ok(!context.includes('[Source 2'), 'one document must not consume two numbers');
  });

  test('pages accumulate across a document\'s chunks and are sorted', () => {
    const { sources } = buildGroundedContext(found([
      chunk({ chunkId: 'a', pageNumber: 9 }),
      chunk({ chunkId: 'b', pageNumber: 2 }),
      chunk({ chunkId: 'c', pageNumber: 9 }),
    ]));
    assert.deepEqual(sources[0]!.pages, [2, 9]);
  });

  test('distinct documents get sequential 1-based numbers matching their blocks', () => {
    const { context, sources } = buildGroundedContext(found([
      chunk({ source: HANDBOOK }),
      chunk({ source: OFFICERS }),
    ]));
    assert.deepEqual(sources.map((s) => s.number), [1, 2]);
    assert.match(context, /\[Source 1 —/);
    assert.match(context, /\[Source 2 —/);
  });

  test('a chunk with no page number contributes no pages', () => {
    const { sources } = buildGroundedContext(found([chunk({ pageNumber: null })]));
    assert.deepEqual(sources[0]!.pages, []);
  });
});

describe('deriveTitle', () => {
  test('turns a document path into a readable title', () => {
    assert.equal(deriveTitle('https://uniben.edu/principal-officers.html'), 'Principal Officers');
  });

  test('strips document extensions', () => {
    assert.equal(deriveTitle('https://uniben.edu/admission_policy.pdf'), 'Admission Policy');
  });

  test('falls back to the hostname when there is no path segment', () => {
    assert.equal(deriveTitle('https://www.uniben.edu/'), 'uniben.edu');
  });

  test('returns a non-URL source unchanged rather than throwing', () => {
    assert.equal(deriveTitle('internal-record'), 'internal-record');
  });
});
