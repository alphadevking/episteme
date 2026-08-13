// episteme-core/src/evals/attribution.test.ts
/**
 * Attribution scoring is pure and therefore fully testable without a network,
 * a model, or a corpus — which is the whole reason the structural tier was
 * separated from the semantic one.
 *
 * The answers below are taken from real prompt-eval output where possible, so
 * the boundaries this pins are the ones the live system actually walks up to.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStatements,
  scoreAttribution,
  scoreCitationSupport,
  formatAttribution,
} from './attribution';

const src = (...numbers: number[]) => numbers.map((number) => ({ number }));

describe('parseStatements — segmentation', () => {
  test('splits prose into sentences and strips citation badges', () => {
    const s = parseStatements('The VC is Professor Omoregie [1](cite:1). He was appointed by council.');
    assert.equal(s.length, 2);
    assert.equal(s[0]!.text, 'The VC is Professor Omoregie.');
    assert.deepEqual(s[0]!.citations, [{ label: 1, target: 1 }]);
    assert.equal(s[1]!.citations.length, 0);
  });

  test('a decimal does not end a sentence', () => {
    const s = parseStatements('An A grade is worth 5.0 points overall.');
    assert.equal(s.length, 1);
  });

  test('list items are one statement each and are not sentence-split', () => {
    // A procedure step is a single assertion carrying a single citation.
    // Slicing it would invent uncited fragments that were never claims.
    const answer = [
      '1. Multiply units by grade point. Sum across semesters [2](cite:2).',
      '2. Divide the total by the credit units [3](cite:3).',
    ].join('\n');
    const s = parseStatements(answer);
    assert.equal(s.length, 2);
    assert.equal(s[0]!.citations.length, 1);
    assert.equal(s[1]!.citations.length, 1);
  });

  test('headings and horizontal rules are dropped entirely', () => {
    const s = parseStatements('## How to apply\n\n---\n\nSubmit the form [1](cite:1).');
    assert.equal(s.length, 1);
    assert.equal(s[0]!.text, 'Submit the form.');
  });

  test('labels and colon-terminated stems are kept but expect no citation', () => {
    const answer = [
      'To calculate your CGPA, follow these steps:',
      '1. **Grade Point Conversion**:',
      'Fees are payable in full [1](cite:1).',
    ].join('\n');
    const s = parseStatements(answer);
    assert.equal(s.filter((x) => x.expectsCitation).length, 1);
    assert.equal(s.filter((x) => x.expectsCitation)[0]!.text, 'Fees are payable in full.');
    // Everything is still returned, so the classification is auditable.
    assert.equal(s.length, 3);
  });
});

describe('scoreAttribution — structural defects', () => {
  test('a citation with no matching source is dangling', () => {
    // The badge renders against nothing. Unambiguous, no interpretation needed.
    const r = scoreAttribution('Fees are due in October [5](cite:5).', src(1, 2, 3));
    assert.equal(r.dangling.length, 1);
    assert.equal(r.dangling[0]!.target, 5);
  });

  test('valid citations are not dangling', () => {
    const r = scoreAttribution('Fees are due in October [2](cite:2).', src(1, 2, 3));
    assert.equal(r.dangling.length, 0);
  });

  test('a label disagreeing with its anchor is flagged', () => {
    // The reader is shown [2] while the client resolves source 5.
    const r = scoreAttribution('Fees are due in October [2](cite:5).', src(1, 2, 3, 4, 5));
    assert.equal(r.mismatched.length, 1);
    assert.deepEqual(r.mismatched[0], { label: 2, target: 5 });
    assert.equal(r.dangling.length, 0, 'target 5 exists, so it is malformed but not dangling');
  });

  test('coverage counts only statements that expect a citation', () => {
    const answer = [
      'Here is how it works:',
      'Registration closes in October [1](cite:1).',
      'Late registration incurs a fee.',
    ].join('\n');
    const r = scoreAttribution(answer, src(1));
    assert.equal(r.claimCount, 2);
    assert.equal(r.citedClaimCount, 1);
    assert.equal(r.citationCoverage, 0.5);
  });

  test('sources returned but never cited are reported', () => {
    const r = scoreAttribution('Fees are due in October [1](cite:1).', src(1, 2, 3));
    assert.deepEqual(r.uncitedSources, [2, 3]);
  });

  test('statements carrying several citations are counted', () => {
    const r = scoreAttribution('An event is scheduled [3](cite:3)[4](cite:4).', src(3, 4));
    assert.equal(r.multiCited, 1);
    assert.equal(r.totalCitations, 2);
  });

  test('an answer with no claims scores coverage 1 rather than NaN', () => {
    const r = scoreAttribution('## Heading only', src(1));
    assert.equal(r.claimCount, 0);
    assert.equal(r.citationCoverage, 1);
  });

  test('an abstention with no sources and no citations is clean', () => {
    const r = scoreAttribution(
      'I do not have verified information on that. Would you like (A) fees or (B) hostels?',
      [],
    );
    assert.equal(r.dangling.length, 0);
    assert.equal(r.totalCitations, 0);
    assert.deepEqual(r.uncitedSources, []);
  });
});

describe('scoreCitationSupport — ALCE tier', () => {
  // A stub judge stands in for an NLI model. It is keyword-based ON PURPOSE and
  // ONLY here: these tests pin the precision/recall ARITHMETIC, not entailment.
  // Shipping such a judge would silently reduce ALCE to string overlap, which is
  // exactly what this module's header warns against.
  const judgeOn = (needle: string) =>
    async (_claim: string, passage: string) => passage.includes(needle);

  test('a claim supported by its cited passage counts toward recall', async () => {
    const report = scoreAttribution('Registration closes in October [1](cite:1).', src(1));
    const out = await scoreCitationSupport(report, new Map([[1, 'closes in October']]), judgeOn('October'));
    assert.equal(out.citationRecall, 1);
    assert.equal(out.judged, 1);
    assert.deepEqual(out.unsupported, []);
  });

  test('a claim whose citation does not support it is reported unsupported', async () => {
    const report = scoreAttribution('Registration closes in October [1](cite:1).', src(1));
    const out = await scoreCitationSupport(report, new Map([[1, 'library opening hours']]), judgeOn('October'));
    assert.equal(out.citationRecall, 0);
    assert.equal(out.unsupported.length, 1);
  });

  test('a padding citation lowers precision without lowering recall', async () => {
    // Source 1 supports the claim; source 2 is stacked on and contributes
    // nothing. This is the semantic version of the stacked-badge defect the
    // format scorer can only see syntactically.
    const report = scoreAttribution('Registration closes in October [1](cite:1)[2](cite:2).', src(1, 2));
    const passages = new Map([[1, 'closes in October'], [2, 'unrelated text']]);
    const out = await scoreCitationSupport(report, passages, judgeOn('October'));
    assert.equal(out.citationRecall, 1, 'the claim is still supported');
    assert.equal(out.citationPrecision, 0.5, 'one of two citations was padding');
  });

  test('uncited claims are excluded from both metrics, not scored as failures', async () => {
    // They are a coverage failure, reported separately. Folding them in would
    // conflate "cited the wrong thing" with "cited nothing".
    const report = scoreAttribution('Registration closes in October.', src(1));
    const out = await scoreCitationSupport(report, new Map([[1, 'October']]), judgeOn('October'));
    assert.equal(out.judged, 0);
    assert.equal(report.citationCoverage, 0);
  });
});

describe('formatAttribution', () => {
  test('a clean answer reports coverage and citation count only', () => {
    const line = formatAttribution(scoreAttribution('Fees are due [1](cite:1).', src(1)));
    assert.match(line, /coverage 100\.0%/);
    assert.ok(!line.includes('DANGLING'));
  });

  test('defects are surfaced with the offending source numbers', () => {
    const line = formatAttribution(scoreAttribution('Fees are due [9](cite:9).', src(1)));
    assert.match(line, /DANGLING \[9\]/);
    assert.match(line, /1 source\(s\) never cited/);
  });
});
