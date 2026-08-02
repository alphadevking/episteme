// episteme-core/src/mastra/tools/relevance-gate.test.ts
/**
 * The relevance decision is one rule with one owner. These tests pin the part
 * that was wrong before it existed: an embedding threshold vetoing a result the
 * cross-encoder had already approved.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { clearsRelevanceGate } from './relevance-gate';

const THRESHOLD = 0.68;

describe('clearsRelevanceGate', () => {
  test('nothing found never clears, whatever judged it', () => {
    assert.equal(clearsRelevanceGate({ found: false }, THRESHOLD), false);
    assert.equal(clearsRelevanceGate({ found: false, judgedBy: 'rerank' }, THRESHOLD), false);
  });

  /**
   * The bug this module was extracted to fix. The cross-encoder kept this chunk,
   * so it passed a stronger test than embedding similarity applies — the 0.66
   * embedding score is stale information and must not veto it.
   */
  test('a rerank-judged result clears even with a low embedding score', () => {
    assert.equal(
      clearsRelevanceGate({ found: true, maxScore: 0.66, judgedBy: 'rerank' }, THRESHOLD),
      true,
    );
  });

  test('a rerank-judged result does not consult the embedding score at all', () => {
    for (const maxScore of [0, 0.1, 0.5, 0.99, undefined]) {
      assert.equal(
        clearsRelevanceGate({ found: true, maxScore, judgedBy: 'rerank' }, THRESHOLD),
        true,
        `rerank verdict should stand at embedding score ${maxScore}`,
      );
    }
  });

  test('an embedding-judged result still honours the threshold in both directions', () => {
    assert.equal(clearsRelevanceGate({ found: true, maxScore: 0.70, judgedBy: 'embedding' }, THRESHOLD), true);
    assert.equal(clearsRelevanceGate({ found: true, maxScore: 0.67, judgedBy: 'embedding' }, THRESHOLD), false);
  });

  test('the threshold is inclusive at the boundary', () => {
    assert.equal(clearsRelevanceGate({ found: true, maxScore: THRESHOLD, judgedBy: 'embedding' }, THRESHOLD), true);
  });

  /**
   * Fail closed. A caller that forgets to plumb `judgedBy` must get the
   * STRICTER behaviour, never a free pass — otherwise a plumbing mistake
   * silently disables the gate.
   */
  test('a missing judge falls back to the embedding threshold', () => {
    assert.equal(clearsRelevanceGate({ found: true, maxScore: 0.66 }, THRESHOLD), false);
    assert.equal(clearsRelevanceGate({ found: true, maxScore: 0.70 }, THRESHOLD), true);
    assert.equal(clearsRelevanceGate({ found: true }, THRESHOLD), false);
  });
});
