// lib/admin/kb-sync.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRecordIngest, type RecordIngestInput } from './kb-sync';

const base: RecordIngestInput = {
  requestedDryRun: false,
  payload: { success: true },
  docId: 'uniben-main-admissionrequirements',
  institutionId: 'ab282ad9-0000-0000-0000-000000000000',
};

describe('shouldRecordIngest — a real ingest', () => {
  test('records when the stream succeeded and the scope is complete', () => {
    assert.equal(shouldRecordIngest(base), true);
  });
});

describe('shouldRecordIngest — a preview must never be recorded', () => {
  test('refuses when the request asked for a preview', () => {
    assert.equal(shouldRecordIngest({ ...base, requestedDryRun: true }), false);
  });

  test('refuses when the stream reports a preview', () => {
    // The exact payload core emits from its dryRun path. Before this guard,
    // `success: true` alone was enough to write a kb_document_sources row and
    // an audit entry for a document that does not exist.
    assert.equal(
      shouldRecordIngest({ ...base, payload: { success: true, dryRun: true } }),
      false,
    );
  });

  test('refuses when either signal alone says preview', () => {
    // Independent reasons: losing one must not re-open the hole.
    assert.equal(shouldRecordIngest({ ...base, requestedDryRun: true, payload: { success: true } }), false);
    assert.equal(shouldRecordIngest({ ...base, requestedDryRun: false, payload: { success: true, dryRun: true } }), false);
  });
});

describe('shouldRecordIngest — incomplete or unsuccessful', () => {
  test('refuses when the stream did not report success', () => {
    assert.equal(shouldRecordIngest({ ...base, payload: {} }), false);
    assert.equal(shouldRecordIngest({ ...base, payload: { success: false } }), false);
  });

  test('a truthy non-true success is not success', () => {
    assert.equal(
      shouldRecordIngest({ ...base, payload: { success: 'yes' as unknown as boolean } }),
      false,
    );
  });

  test('refuses without a docId — there is nothing to key the row on', () => {
    assert.equal(shouldRecordIngest({ ...base, docId: undefined }), false);
    assert.equal(shouldRecordIngest({ ...base, docId: '' }), false);
    assert.equal(shouldRecordIngest({ ...base, docId: null }), false);
  });

  test('refuses without an institution — a global document has no owner row', () => {
    assert.equal(shouldRecordIngest({ ...base, institutionId: null }), false);
  });
});
