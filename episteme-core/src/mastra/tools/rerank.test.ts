// episteme-core/src/mastra/tools/rerank.test.ts
/**
 * Unit tests for cross-encoder reranking.
 *
 * The provider call is injected, so these run with no credentials and no
 * network. Two properties matter most and neither is visible in a happy-path
 * run: a provider failure must NOT break retrieval, and a provider that judges
 * everything irrelevant MUST be able to empty the result set — that is how
 * abstention on an off-topic query works.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyRerankScores, rerankChunks, type RerankScore } from './rerank';

const chunk = (text: string) => ({ text });
const ok = (rerankScores: RerankScore[]) => async () => rerankScores;

describe('applyRerankScores', () => {
  test('reorders by rerank score, not input order', () => {
    const chunks = [chunk('a'), chunk('b'), chunk('c')];
    const { kept } = applyRerankScores(chunks, [
      { index: 2, score: 0.9 },
      { index: 0, score: 0.5 },
      { index: 1, score: 0.7 },
    ], 0);
    assert.deepEqual(kept.map((c) => c.text), ['c', 'b', 'a']);
  });

  test('drops chunks below the floor and counts them', () => {
    const chunks = [chunk('a'), chunk('b')];
    const result = applyRerankScores(chunks, [
      { index: 0, score: 0.8 },
      { index: 1, score: 0.1 },
    ], 0.5);
    assert.deepEqual(result.kept.map((c) => c.text), ['a']);
    assert.equal(result.droppedByFloor, 1);
  });

  /**
   * An empty response is "no judgement", not "nothing is relevant". Treating
   * the two the same would silently empty every result set the moment a
   * provider returned a blank body.
   */
  test('an empty score list keeps the input untouched', () => {
    const chunks = [chunk('a'), chunk('b')];
    const { kept, droppedByFloor } = applyRerankScores(chunks, [], 0.9);
    assert.deepEqual(kept.map((c) => c.text), ['a', 'b']);
    assert.equal(droppedByFloor, 0);
  });

  test('ignores out-of-range and non-integer indices', () => {
    const chunks = [chunk('a')];
    const { kept } = applyRerankScores(chunks, [
      { index: 5, score: 0.9 },
      { index: -1, score: 0.9 },
      { index: 0.5, score: 0.9 },
      { index: 0, score: 0.9 },
    ], 0);
    assert.deepEqual(kept.map((c) => c.text), ['a']);
  });

  test('honours a duplicated index only once', () => {
    const chunks = [chunk('a'), chunk('b')];
    const { kept } = applyRerankScores(chunks, [
      { index: 0, score: 0.9 },
      { index: 0, score: 0.8 },
    ], 0);
    assert.deepEqual(kept.map((c) => c.text), ['a']);
  });

  test('a chunk the provider omitted is not resurrected', () => {
    const chunks = [chunk('a'), chunk('b')];
    const { kept } = applyRerankScores(chunks, [{ index: 0, score: 0.9 }], 0);
    assert.deepEqual(kept.map((c) => c.text), ['a']);
  });
});

describe('rerankChunks', () => {
  test('returns reranked results with their scores', async () => {
    const outcome = await rerankChunks('q', [chunk('a'), chunk('b')], {
      enabled: true,
      minScore: 0,
      rerankFn: ok([{ index: 1, score: 0.9 }, { index: 0, score: 0.4 }]),
    });
    assert.equal(outcome.status, 'reranked');
    assert.deepEqual(outcome.results.map((c) => c.text), ['b', 'a']);
    assert.deepEqual(outcome.scores, [0.9, 0.4]);
  });

  /**
   * The whole point of the layer: an off-topic query whose chunks cleared the
   * embedding floor must be able to end with nothing. "Harvard University"
   * against a Uniben handbook is the real case.
   */
  test('can empty the result set when everything is judged irrelevant', async () => {
    const outcome = await rerankChunks('how do I apply to Harvard', [chunk('uniben handbook')], {
      enabled: true,
      minScore: 0.5,
      rerankFn: ok([{ index: 0, score: 0.02 }]),
    });
    assert.equal(outcome.status, 'reranked');
    assert.deepEqual(outcome.results, []);
  });

  /**
   * Fail-soft. A rerank outage must degrade relevance, never break the answer —
   * the same lesson the storage incident taught, applied in advance.
   */
  test('falls back to embedding order when the provider throws', async () => {
    const warnings: string[] = [];
    const outcome = await rerankChunks('q', [chunk('a'), chunk('b')], {
      enabled: true,
      minScore: 0.5,
      rerankFn: async () => { throw new Error('rerank service unavailable'); },
      logger: { warn: (msg) => warnings.push(msg) },
    });
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(outcome.results.map((c) => c.text), ['a', 'b']);
    assert.equal(warnings.length, 1);
  });

  test('is a no-op when disabled', async () => {
    let called = false;
    const outcome = await rerankChunks('q', [chunk('a')], {
      enabled: false,
      minScore: 0.9,
      rerankFn: async () => { called = true; return []; },
    });
    assert.equal(outcome.status, 'disabled');
    assert.equal(called, false, 'must not call the provider when disabled');
    assert.deepEqual(outcome.results.map((c) => c.text), ['a']);
  });

  test('does not call the provider for an empty input', async () => {
    let called = false;
    const outcome = await rerankChunks('q', [], {
      enabled: true,
      minScore: 0.5,
      rerankFn: async () => { called = true; return []; },
    });
    assert.equal(outcome.status, 'skipped-empty');
    assert.equal(called, false);
  });
});
