// episteme-core/src/evals/retrieval-metrics.test.ts
/**
 * Unit tests for the retrieval metrics.
 *
 * These run in the normal suite with no credentials and no network — the metric
 * definitions are the part that must not drift, because every future tuning
 * decision (relevanceThreshold, alpha, topK) will be argued from the numbers
 * they produce. A metric that is subtly wrong is worse than no metric: it moves
 * decisions confidently in the wrong direction.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSeparation,
  classifyAtThreshold,
  matchesLabel,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  ndcgAtK,
  scoreCase,
  summarize,
  mean,
  type RetrievedItem,
} from './retrieval-metrics';

const item = (source: string, score = 0.7): RetrievedItem => ({ source, score });

describe('matchesLabel', () => {
  test('matches case-insensitively on a substring', () => {
    assert.ok(matchesLabel('https://uniben.edu/Student-Handbook.pdf', 'student-handbook'));
    assert.ok(matchesLabel('student-handbook.pdf', 'Student-Handbook.pdf'));
  });

  test('does not match an unrelated source', () => {
    assert.equal(matchesLabel('fees-schedule.pdf', 'student-handbook'), false);
  });
});

describe('precisionAtK', () => {
  test('all retrieved are relevant → 1.0', () => {
    const retrieved = [item('handbook.pdf'), item('handbook.pdf')];
    assert.equal(precisionAtK(retrieved, ['handbook'], 3), 1);
  });

  test('half relevant → 0.5', () => {
    const retrieved = [item('handbook.pdf'), item('unrelated.pdf')];
    assert.equal(precisionAtK(retrieved, ['handbook'], 2), 0.5);
  });

  /**
   * The denominator is min(k, retrieved.length). Two correct results out of two
   * returned is perfect precision — dividing by k would report 0.67 and punish
   * the system for the corpus holding fewer than k relevant documents.
   */
  test('fewer results than k does not deflate the score', () => {
    const retrieved = [item('handbook.pdf'), item('handbook.pdf')];
    assert.equal(precisionAtK(retrieved, ['handbook'], 5), 1);
  });

  test('nothing retrieved → 0, not NaN', () => {
    assert.equal(precisionAtK([], ['handbook'], 3), 0);
  });

  test('only the top k are considered', () => {
    const retrieved = [item('bad.pdf'), item('bad.pdf'), item('handbook.pdf')];
    assert.equal(precisionAtK(retrieved, ['handbook'], 2), 0);
  });
});

describe('recallAtK', () => {
  test('finds one of two labelled documents → 0.5', () => {
    const retrieved = [item('handbook.pdf')];
    assert.equal(recallAtK(retrieved, ['handbook', 'fees-schedule'], 3), 0.5);
  });

  /**
   * Counting items instead of distinct labels is the classic bug here: three
   * chunks of one document would report recall 3/1 = 3.0.
   */
  test('several chunks of one document count once — never exceeds 1.0', () => {
    const retrieved = [item('handbook.pdf'), item('handbook.pdf'), item('handbook.pdf')];
    assert.equal(recallAtK(retrieved, ['handbook'], 5), 1);
  });

  test('no labels → 0, not NaN', () => {
    assert.equal(recallAtK([item('a.pdf')], [], 3), 0);
  });
});

describe('reciprocalRank', () => {
  test('first position → 1.0', () => {
    assert.equal(reciprocalRank([item('handbook.pdf'), item('x.pdf')], ['handbook']), 1);
  });

  test('third position → 1/3', () => {
    const retrieved = [item('x.pdf'), item('y.pdf'), item('handbook.pdf')];
    assert.equal(reciprocalRank(retrieved, ['handbook']), 1 / 3);
  });

  test('absent → 0', () => {
    assert.equal(reciprocalRank([item('x.pdf')], ['handbook']), 0);
  });
});

describe('ndcgAtK', () => {
  test('ideal ordering → 1.0', () => {
    const retrieved = [item('handbook.pdf'), item('x.pdf')];
    assert.equal(ndcgAtK(retrieved, ['handbook'], 3), 1);
  });

  test('rewards being right earlier', () => {
    const early = ndcgAtK([item('handbook.pdf'), item('x.pdf'), item('y.pdf')], ['handbook'], 3);
    const late  = ndcgAtK([item('x.pdf'), item('y.pdf'), item('handbook.pdf')], ['handbook'], 3);
    assert.ok(early > late, `expected earlier hit to score higher (${early} vs ${late})`);
  });

  /**
   * With 3 labels and k=2 the best achievable is 2 hits in 2 slots. The ideal
   * DCG must be capped at k or the ceiling is unreachable and a perfect result
   * reports as a failure.
   */
  test('more labels than k can still reach 1.0', () => {
    const retrieved = [item('a.pdf'), item('b.pdf')];
    assert.equal(ndcgAtK(retrieved, ['a', 'b', 'c'], 2), 1);
  });

  test('no hits → 0', () => {
    assert.equal(ndcgAtK([item('x.pdf')], ['handbook'], 3), 0);
  });

  /**
   * Regression: a real run scored nDCG 2.131. All three retrieved chunks came
   * from one document, and each was credited as a separate relevant item while
   * the ideal was built from the single label. nDCG is a normalised measure —
   * exceeding 1.0 is definitionally impossible and made the number worthless.
   */
  test('several chunks of one document cannot push nDCG above 1.0', () => {
    const retrieved = [item('admission_policy.html'), item('admission_policy.html'), item('admission_policy.html')];
    assert.equal(ndcgAtK(retrieved, ['admission_policy'], 3), 1);
  });

  test('never exceeds 1.0 for any duplication of any label set', () => {
    const retrieved = [item('a.pdf'), item('a.pdf'), item('b.pdf'), item('b.pdf'), item('a.pdf')];
    for (const labels of [['a'], ['b'], ['a', 'b']]) {
      for (const k of [1, 2, 3, 5]) {
        const value = ndcgAtK(retrieved, labels, k);
        assert.ok(value <= 1, `nDCG@${k} for [${labels}] was ${value}`);
      }
    }
  });

  /**
   * The credited document is the best-ranked one, so duplicates must not
   * displace a second distinct document's contribution.
   */
  test('a duplicate does not consume the credit owed to another document', () => {
    const duplicateFirst = ndcgAtK([item('a.pdf'), item('a.pdf'), item('b.pdf')], ['a', 'b'], 3);
    const distinctFirst  = ndcgAtK([item('a.pdf'), item('b.pdf')], ['a', 'b'], 3);
    assert.ok(duplicateFirst < distinctFirst, 'burying the second document should score lower');
    assert.ok(duplicateFirst > 0);
  });
});

describe('scoreCase', () => {
  test('reports anyHit false when nothing labelled came back', () => {
    const score = scoreCase([item('x.pdf'), item('y.pdf')], ['handbook'], 3);
    assert.equal(score.anyHit, false);
    assert.equal(score.precision, 0);
    assert.equal(score.recall, 0);
  });

  test('reports anyHit true for a hit below k', () => {
    const score = scoreCase([item('x.pdf'), item('handbook.pdf')], ['handbook'], 3);
    assert.equal(score.anyHit, true);
  });

  /**
   * The distinction this pair of metrics exists to make: ranking correctly and
   * returning an extra document is NOT the same failure as ranking wrongly.
   * Measured on the real platform corpus, the first shape is what happens.
   */
  test('separates "ranked right, returned extra" from "ranked wrong"', () => {
    const rightThenExtra = scoreCase([item('handbook.pdf'), item('other.pdf')], ['handbook'], 3);
    assert.equal(rightThenExtra.precisionAt1, 1);
    assert.equal(rightThenExtra.precision, 0.5);

    const wrongFirst = scoreCase([item('other.pdf'), item('handbook.pdf')], ['handbook'], 3);
    assert.equal(wrongFirst.precisionAt1, 0);
    assert.equal(wrongFirst.precision, 0.5);
  });
});

describe('analyzeSeparation — threshold calibration', () => {
  test('clean separation is reported with a positive margin', () => {
    const analysis = analyzeSeparation([0.80, 0.85, 0.90], [0.40, 0.50, 0.55]);
    assert.equal(analysis.cleanlySeparable, true);
    assert.ok(analysis.margin > 0);
    assert.equal(analysis.falseAbstain, 0);
    assert.equal(analysis.falseAnswer, 0);
    assert.equal(analysis.accuracy, 1);
    // Must exclude the top out-of-domain score and admit the lowest in-domain one.
    assert.ok(analysis.bestThreshold > 0.55 && analysis.bestThreshold <= 0.80);
  });

  /**
   * The case that actually matters for this corpus: out-of-domain queries score
   * ABOVE some in-domain ones, so no cutoff classifies everything correctly.
   * Reporting a confident threshold here would be the wrong answer dressed up
   * as a measurement.
   */
  test('overlap is reported as not cleanly separable, with a negative margin', () => {
    const analysis = analyzeSeparation([0.60, 0.70, 0.80], [0.50, 0.66, 0.74]);
    assert.equal(analysis.cleanlySeparable, false);
    assert.ok(analysis.margin < 0);
    assert.ok(analysis.accuracy < 1, 'no threshold should achieve perfect accuracy under overlap');
    assert.ok(analysis.falseAbstain + analysis.falseAnswer > 0);
  });

  /**
   * Fail closed: with equal accuracy available on either side of a gap, prefer
   * the higher threshold. Abstaining on a real question is recoverable;
   * answering an out-of-domain question from unrelated documents is fabrication.
   */
  test('ties are broken toward the higher threshold', () => {
    const analysis = analyzeSeparation([0.90], [0.30]);
    assert.equal(analysis.accuracy, 1);
    assert.ok(
      analysis.bestThreshold > 0.30,
      `expected a threshold above the out-of-domain score, got ${analysis.bestThreshold}`,
    );
  });

  test('classifyAtThreshold counts both error directions', () => {
    const result = classifyAtThreshold([0.4, 0.9], [0.3, 0.8], 0.5);
    assert.equal(result.falseAbstain, 1); // 0.4 in-domain falls below
    assert.equal(result.falseAnswer, 1);  // 0.8 out-of-domain clears
    assert.equal(result.accuracy, 0.5);
  });

  test('empty inputs do not throw or claim separability', () => {
    const analysis = analyzeSeparation([], []);
    assert.equal(analysis.cleanlySeparable, false);
    assert.equal(analysis.accuracy, 0);
  });
});

describe('summarize', () => {
  test('macro-averages cases and counts misses and abstentions', () => {
    const perfect = scoreCase([item('a.pdf')], ['a'], 3);
    const miss    = scoreCase([item('z.pdf')], ['a'], 3);

    const summary = summarize([perfect, miss], [true, true, false]);

    assert.equal(summary.retrievalCases, 2);
    assert.equal(summary.precision, 0.5);       // (1 + 0) / 2
    assert.equal(summary.totalMisses, 1);
    assert.equal(summary.abstentionCases, 3);
    assert.equal(summary.abstentionCorrect, 2);
  });

  test('empty input produces zeros rather than NaN', () => {
    const summary = summarize([], []);
    assert.equal(summary.precision, 0);
    assert.equal(summary.mrr, 0);
    assert.equal(mean([]), 0);
  });
});
