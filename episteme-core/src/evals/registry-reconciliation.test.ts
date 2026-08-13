// episteme-core/src/evals/registry-reconciliation.test.ts
/**
 * The healthy fixture is the real 2026-08-13 corpus: three documents, three
 * namespaces, 458 vectors. Every failure case below is that same corpus with
 * one thing broken, so a reader can see exactly what each detector reacts to.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatReconciliation,
  reconcileRegistry,
  type RegistryDocument,
} from './registry-reconciliation';

const HEALTHY_REGISTRY: RegistryDocument[] = [
  { docId: 'd1', fileName: 'STUDENTHANDBOOK.pdf',           namespace: 'general',         vectorsUpserted: 391 },
  { docId: 'd2', fileName: 'admission_policy.html',         namespace: 'admissions',      vectorsUpserted: 55 },
  { docId: 'd3', fileName: 'ACADEMIC_CALENDAR_PG_2026.pdf', namespace: 'academic-policy', vectorsUpserted: 12 },
];

const HEALTHY_CENSUS = { general: 391, admissions: 55, 'academic-policy': 12 };

describe('reconcileRegistry — the healthy corpus', () => {
  test('a matching registry and index reconcile', () => {
    const r = reconcileRegistry(HEALTHY_REGISTRY, HEALTHY_CENSUS);
    assert.equal(r.reconciled, true);
    assert.deepEqual(r.registeredButAbsent, []);
    assert.deepEqual(r.presentButUnregistered, []);
    assert.deepEqual(r.drift, []);
    assert.equal(r.registryDocuments, 3);
    assert.equal(r.registryVectors, 458);
    assert.equal(r.indexVectors, 458);
  });
});

describe('reconcileRegistry — registered but absent', () => {
  test('a document recorded as ingested with no vectors is caught', () => {
    // The failure an operator cannot otherwise see: the admin UI lists the
    // document, retrieval can never return it, and the abstention is
    // indistinguishable from a genuine coverage gap.
    const census = { general: 391, admissions: 55 }; // academic-policy vanished
    const r = reconcileRegistry(HEALTHY_REGISTRY, census);

    assert.equal(r.reconciled, false);
    assert.equal(r.registeredButAbsent.length, 1);
    assert.deepEqual(r.registeredButAbsent[0], {
      namespace: 'academic-policy', documents: 1, expectedVectors: 12,
    });
  });

  test('a namespace explicitly at zero is treated the same as a missing key', () => {
    // Pinecone omits empty namespaces from describeIndexStats entirely, so the
    // two must not be distinguished.
    const r = reconcileRegistry(HEALTHY_REGISTRY, { ...HEALTHY_CENSUS, 'academic-policy': 0 });
    assert.equal(r.registeredButAbsent.length, 1);
    assert.equal(r.registeredButAbsent[0]!.namespace, 'academic-policy');
  });

  test('several documents in one absent namespace are counted together', () => {
    const registry: RegistryDocument[] = [
      { docId: 'a', fileName: 'a.pdf', namespace: 'financial-aid', vectorsUpserted: 10 },
      { docId: 'b', fileName: 'b.pdf', namespace: 'financial-aid', vectorsUpserted: 7 },
    ];
    const r = reconcileRegistry(registry, HEALTHY_CENSUS);
    assert.deepEqual(r.registeredButAbsent[0], {
      namespace: 'financial-aid', documents: 2, expectedVectors: 17,
    });
  });
});

describe('reconcileRegistry — present but unregistered', () => {
  test('vectors with no registry row are caught', () => {
    // Retrievable content nobody can attribute, re-ingest, or delete through
    // the admin path — that path works from the registry.
    const census = { ...HEALTHY_CENSUS, 'staff-internal': 40 };
    const r = reconcileRegistry(HEALTHY_REGISTRY, census);

    assert.equal(r.reconciled, false);
    assert.deepEqual(r.presentButUnregistered, [{ namespace: 'staff-internal', vectors: 40 }]);
  });

  test('an empty namespace is not reported as unregistered', () => {
    // Nothing is there. There is nothing to account for.
    const r = reconcileRegistry(HEALTHY_REGISTRY, { ...HEALTHY_CENSUS, 'staff-internal': 0 });
    assert.deepEqual(r.presentButUnregistered, []);
    assert.equal(r.reconciled, true);
  });

  test('ignored namespaces are excluded from both directions', () => {
    // The platform documentation tier ships in the repository and is read from
    // disk, so it would otherwise be reported as unregistered on every run.
    const census = { ...HEALTHY_CENSUS, 'platform-help': 25 };
    const r = reconcileRegistry(HEALTHY_REGISTRY, census, ['platform-help']);
    assert.deepEqual(r.presentButUnregistered, []);
    assert.equal(r.indexVectors, 458, 'ignored vectors are excluded from the total');
    assert.equal(r.reconciled, true);
  });
});

describe('reconcileRegistry — drift is reported, not failed', () => {
  test('a count mismatch is drift and does not break reconciliation', () => {
    // Re-ingesting a document upserts the same vector ids, so the registry's
    // running total legitimately exceeds the index's distinct count.
    const r = reconcileRegistry(HEALTHY_REGISTRY, { ...HEALTHY_CENSUS, general: 380 });
    assert.equal(r.reconciled, true, 'drift alone is not a failure');
    assert.deepEqual(r.drift, [{ namespace: 'general', registry: 391, index: 380, delta: -11 }]);
  });

  test('a positive delta is reported too', () => {
    const r = reconcileRegistry(HEALTHY_REGISTRY, { ...HEALTHY_CENSUS, general: 400 });
    assert.equal(r.drift[0]!.delta, 9);
  });
});

describe('reconcileRegistry — degenerate input', () => {
  test('an empty registry against an empty index reconciles', () => {
    const r = reconcileRegistry([], {});
    assert.equal(r.reconciled, true);
    assert.equal(r.registryDocuments, 0);
  });

  test('an empty registry against a populated index reports everything unregistered', () => {
    const r = reconcileRegistry([], HEALTHY_CENSUS);
    assert.equal(r.reconciled, false);
    assert.equal(r.presentButUnregistered.length, 3);
  });

  test('a populated registry against an empty index reports everything absent', () => {
    const r = reconcileRegistry(HEALTHY_REGISTRY, {});
    assert.equal(r.reconciled, false);
    assert.equal(r.registeredButAbsent.length, 3);
    assert.equal(r.indexVectors, 0);
  });

  test('a nonsensical vector count is treated as zero rather than corrupting totals', () => {
    const registry: RegistryDocument[] = [
      { docId: 'a', fileName: 'a.pdf', namespace: 'general', vectorsUpserted: -5 },
      { docId: 'b', fileName: 'b.pdf', namespace: 'general', vectorsUpserted: 391 },
    ];
    const r = reconcileRegistry(registry, { general: 391 });
    assert.equal(r.registryVectors, 391);
    assert.deepEqual(r.drift, []);
  });
});

describe('formatReconciliation', () => {
  test('a clean run says so', () => {
    const out = formatReconciliation(reconcileRegistry(HEALTHY_REGISTRY, HEALTHY_CENSUS));
    assert.match(out, /RECONCILED/);
    assert.ok(!out.includes('REGISTERED BUT ABSENT'));
  });

  test('absent documents are named with their expected volume', () => {
    const out = formatReconciliation(reconcileRegistry(HEALTHY_REGISTRY, { general: 391, admissions: 55 }));
    assert.match(out, /REGISTERED BUT ABSENT/);
    assert.match(out, /academic-policy: 1 document\(s\), 12 vector\(s\) expected, 0 found/);
    assert.ok(!out.includes('RECONCILED'));
  });

  test('unregistered vectors explain why provenance matters', () => {
    const out = formatReconciliation(
      reconcileRegistry(HEALTHY_REGISTRY, { ...HEALTHY_CENSUS, 'staff-internal': 40 }),
    );
    assert.match(out, /PRESENT BUT UNREGISTERED/);
    assert.match(out, /staff-internal: 40 vector\(s\)/);
  });

  test('drift is labelled informational so it is not read as a failure', () => {
    const out = formatReconciliation(reconcileRegistry(HEALTHY_REGISTRY, { ...HEALTHY_CENSUS, general: 380 }));
    assert.match(out, /informational/);
    assert.match(out, /RECONCILED/);
  });
});
