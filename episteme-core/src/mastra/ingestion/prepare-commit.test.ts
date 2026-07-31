// episteme-core/src/mastra/ingestion/prepare-commit.test.ts
/**
 * Tests for the prepare/commit split.
 *
 * Two properties matter here, and neither is visible in a passing ingest:
 *
 *   1. prepareDocument performs NO writes. The dry-run route relies on this
 *      structurally — it calls only prepareDocument, so a preview cannot write
 *      even if a caller passes the wrong flag. A comment cannot enforce that;
 *      this test can.
 *   2. The delete of a previous version happens only after embedding succeeds.
 *      It used to run before chunking, so a zero-chunk result or a transient
 *      embedding failure destroyed the existing vectors with nothing to replace
 *      them — a re-ingest during a provider outage silently emptied a document.
 *
 * These run with no credentials: prepareDocument is exercised through the
 * markdown/plain-text paths, which are local (no Unstructured, no Pinecone).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const MARKDOWN = `# Registration

Course registration opens on 12 March and closes on 30 March.

## Late registration

A late fee applies after the deadline. Students must obtain written approval
from their head of department before the portal will reopen for them.

## Deferment

Deferment requests are considered once per session.
`;

const baseOptions = {
  docId: 'test-prepare-doc',
  fileName: 'registration.md',
  category: 'academic-policy',
  namespace: 'academic-policy',
  faculty: 'general',
  source: 'Registration policy',
  roles: ['student'],
  updatedAt: '2026-01-15T00:00:00.000Z',
  contentType: 'markdown' as const,
  markdownContent: MARKDOWN,
};

describe('prepare.ts — structurally incapable of writing', () => {
  test('imports nothing that can write', async () => {
    // The real guarantee. prepareDocument is write-free not because its body
    // avoids the calls, but because the module has no access to them: no
    // Pinecone client, no embedder, no registry. The dry-run route depends on
    // this, and it is exactly what a well-meaning refactor would undo by
    // "tidying" an import back in.
    const src = await readFile(join(HERE, 'prepare.ts'), 'utf8');
    const imports = src.match(/^import[\s\S]*?from\s+'[^']+';/gm)?.join('\n') ?? '';

    for (const forbidden of ['@pinecone-database/pinecone', './embedder', './kb-store', '../db']) {
      assert.ok(
        !imports.includes(forbidden),
        `prepare.ts must not import ${forbidden} — it is what keeps the prepare phase write-free`,
      );
    }
  });

  test('the prepare body calls no write primitive', async () => {
    const src = await readFile(join(HERE, 'prepare.ts'), 'utf8');
    for (const forbidden of ['deleteDocument(', '.upsert(', 'saveDocument(', 'embedTexts(']) {
      assert.ok(
        !src.includes(forbidden),
        `prepare.ts must not call ${forbidden}`,
      );
    }
  });

  test('commit performs the delete only after embedding', async () => {
    const src = await readFile(join(HERE, 'ingest.ts'), 'utf8');
    const start = src.indexOf('export async function commitDocument');
    const end = src.indexOf('export async function ingestDocument');
    const commitBody = src.slice(start, end);

    const embedAt  = commitBody.indexOf('embedTexts(');
    const deleteAt = commitBody.indexOf('deleteDocument(');
    const upsertAt = commitBody.indexOf('index.upsert(');

    assert.ok(embedAt  > 0, 'embedTexts not found in commitDocument');
    assert.ok(deleteAt > 0, 'deleteDocument not found in commitDocument');
    assert.ok(upsertAt > 0, 'upsert not found in commitDocument');

    assert.ok(
      embedAt < deleteAt,
      'deleteDocument must come AFTER embedTexts — otherwise an embedding failure ' +
      'destroys the existing document with nothing to replace it',
    );
    assert.ok(deleteAt < upsertAt, 'delete must precede upsert so stale chunks are cleared');
  });
});

describe('prepareDocument — output', () => {
  test('produces chunks from markdown without any network call', async () => {
    const { prepareDocument } = await import('./prepare');
    const prepared = await prepareDocument(baseOptions);

    assert.ok(prepared.parents.length > 0, 'no parent chunks produced');
    assert.ok(prepared.children.length > 0, 'no child chunks produced');
    assert.ok(prepared.textLength > 0);
    assert.equal(prepared.docId, baseOptions.docId);
    assert.equal(prepared.namespace, baseOptions.namespace);
    assert.deepEqual(prepared.roles, baseOptions.roles);
  });

  test('carries an undated source through as null, never as a stamped date', async () => {
    const { prepareDocument } = await import('./prepare');
    const prepared = await prepareDocument({ ...baseOptions, updatedAt: null });
    assert.equal(prepared.updatedAt, null);
  });

  test('normalises optional scopes rather than leaving them undefined', async () => {
    const { prepareDocument } = await import('./prepare');
    const prepared = await prepareDocument(baseOptions);
    assert.equal(prepared.programme, null);
    assert.deepEqual(prepared.levels, []);
  });

  test('rejects empty content instead of producing an empty document', async () => {
    const { prepareDocument } = await import('./prepare');
    await assert.rejects(
      () => prepareDocument({ ...baseOptions, markdownContent: '   \n  ' }),
      /No content extracted/,
    );
  });

  test('rejects input with no content source at all', async () => {
    const { prepareDocument } = await import('./prepare');
    await assert.rejects(
      () => prepareDocument({ ...baseOptions, markdownContent: undefined }),
      /One of fileBuffer, markdownContent, or plainTextContent/,
    );
  });
});

describe('summarizePrepared — the dry-run report', () => {
  test('reports counts that match the prepared document', async () => {
    const { prepareDocument, summarizePrepared } = await import('./prepare');
    const prepared = await prepareDocument(baseOptions);
    const report = summarizePrepared(prepared);

    assert.equal(report.parentChunks, prepared.parents.length);
    assert.equal(report.childChunks, prepared.children.length);
    // Every child chunk becomes exactly one vector.
    assert.equal(report.vectorsWouldUpsert, prepared.children.length);
    assert.equal(report.textLength, prepared.textLength);
  });

  test('samples PARENT chunks — the unit retrieval actually hands the model', async () => {
    const { prepareDocument, summarizePrepared } = await import('./prepare');
    const prepared = await prepareDocument(baseOptions);
    const report = summarizePrepared(prepared, 2, 100);

    assert.ok(report.sampleChunks.length <= 2);
    for (const sample of report.sampleChunks) {
      assert.ok(sample.text.length <= 100, 'sample text exceeded the truncation limit');
      // `length` is the FULL parent length, not the truncated preview — a
      // reviewer judging chunk size needs the real number.
      const parent = prepared.parents[sample.index];
      assert.equal(sample.length, parent.text.length);
      assert.ok(parent.text.startsWith(sample.text));
    }
  });

  test('carries the scope fields a reviewer needs to approve the ingest', async () => {
    const { prepareDocument, summarizePrepared } = await import('./prepare');
    const report = summarizePrepared(await prepareDocument(baseOptions));

    // These are the access-control fields — a preview that omitted them would
    // let a reviewer approve an ingest without seeing who can read it.
    assert.equal(report.namespace, 'academic-policy');
    assert.deepEqual(report.roles, ['student']);
    assert.ok('institutionId' in report);
    assert.ok('updatedAt' in report);
  });
});
