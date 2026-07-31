// episteme-core/src/mastra/server/kb-routes.dry-run.test.ts
/**
 * Route-level tests for POST /kb/documents in preview mode.
 *
 * prepare-commit.test.ts proves the *module* cannot write. This proves the
 * *route* reaches only that module — a different claim, and the one that
 * actually protects the KB, since a caller talks to the route and never to
 * prepareDocument directly.
 *
 * The credentials are deliberately fake. That is the mechanism, not a
 * shortcut: with an unusable Pinecone key a real ingest fails loudly while a
 * dry run succeeds, so the two paths are told apart by outcome rather than by
 * trusting the flag we are trying to test. A dry run that had drifted into
 * touching Pinecone would fail here.
 *
 * LIBSQL_URL points at an in-memory database so the registry read the preview
 * performs (`replacesExisting`) cannot see — or disturb — the real mastra.db.
 */
process.env['MASTRA_ADMIN_KEY'] = 'test-admin-key';
process.env['PINECONE_API_KEY'] = 'pclocal-not-a-real-key';
process.env['PINECONE_INDEX']   = 'test-index';
process.env['LIBSQL_URL']       = 'file::memory:';
// Needed only to make the module graph importable: embedder.ts constructs
// ModelRouterEmbeddingModel at import scope, and that constructor throws on a
// missing key. Nothing here ever calls it — a dry run that did would fail on
// the fake value, which is the point. (That import-scope throw is worth making
// lazy; it is the same thing that forced prepare.ts out of ingest.ts.)
process.env['MISTRAL_API_KEY']  = 'not-a-real-key';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextWithMastra } from '@mastra/core/server';

const ADMIN_KEY = 'test-admin-key';

const MARKDOWN = `# Registration

Course registration opens on 12 March and closes on 30 March.

## Late registration

A late fee applies after the deadline. Students must obtain written approval
from their head of department before the portal will reopen for them.

## Deferment

Deferment requests are considered once per session, and only with the approval
of the faculty board. Students on probation are not eligible.
`;

const validBody = {
  docId: 'dry-run-probe',
  fileName: 'registration.md',
  category: 'academic-policy',
  namespace: 'academic-policy',
  faculty: 'general',
  source: 'Registration policy',
  roles: ['student'],
  updatedAt: '2026-01-15T00:00:00.000Z',
  contentType: 'markdown',
  markdownContent: MARKDOWN,
};

/**
 * Minimal stand-in for a Hono context — only the surface the handler touches.
 * Header lookup is case-insensitive, as Hono's is.
 */
function makeCtx(body: unknown, headers: Record<string, string> = {}): ContextWithMastra {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    req: {
      header: (name: string) => lower[name.toLowerCase()],
      json: async () => body,
      param: () => undefined,
    },
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  } as unknown as ContextWithMastra;
}

const authed = (body: unknown) => makeCtx(body, { 'x-episteme-admin-key': ADMIN_KEY });

interface SseEvent { event: string; data: Record<string, unknown> }

/** Drain an SSE response into parsed events. */
async function readEvents(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  const events: SseEvent[] = [];
  for (const block of text.split('\n\n')) {
    const match = block.match(/^event: (.+)\ndata: ([\s\S]+)$/);
    if (match) events.push({ event: match[1]!, data: JSON.parse(match[2]!) });
  }
  return events;
}

const done = (events: SseEvent[]) => events.find((e) => e.event === 'done');

describe('POST /kb/documents — dry run', () => {
  test('returns a report and writes nothing', async () => {
    const { ingestDocumentHandler } = await import('./kb-routes');
    const { getDocument } = await import('../ingestion/kb-store');

    const res = await ingestDocumentHandler(authed({ ...validBody, dryRun: true }));
    assert.equal(res.headers.get('Content-Type'), 'text/event-stream');

    const events = await readEvents(res);
    const error = events.find((e) => e.event === 'error');
    assert.equal(error, undefined, `dry run emitted an error: ${JSON.stringify(error?.data)}`);

    const finished = done(events);
    assert.ok(finished, 'no done event emitted');
    assert.equal(finished.data['success'], true);
    assert.equal(finished.data['dryRun'], true);

    const report = finished.data['report'] as Record<string, unknown>;
    assert.ok((report['parentChunks'] as number) > 0, 'no parent chunks reported');
    assert.ok((report['childChunks'] as number) > 0, 'no child chunks reported');
    assert.equal(report['vectorsWouldUpsert'], report['childChunks']);
    assert.equal(report['namespace'], 'academic-policy');
    assert.deepEqual(report['roles'], ['student']);
    assert.equal(report['replacesExisting'], false);
    assert.equal(report['movesFromNamespace'], null);
    assert.ok((report['sampleChunks'] as unknown[]).length > 0, 'no sample chunks to review');

    // The claim that matters: the registry never learned about this document.
    assert.equal(
      await getDocument(validBody.docId),
      null,
      'a dry run wrote a registry record — it must leave no trace',
    );
  });

  test('never emits progress past chunking', async () => {
    // 'embedding' and 'upserting' are emitted by commitDocument alone. Seeing
    // either would mean the preview crossed into the write phase, whatever the
    // final report said.
    const { ingestDocumentHandler } = await import('./kb-routes');
    const events = await readEvents(
      await ingestDocumentHandler(authed({ ...validBody, dryRun: true })),
    );

    const steps = events
      .filter((e) => e.event === 'progress')
      .map((e) => e.data['step']);

    assert.ok(!steps.includes('embedding'), `preview reached the embedding step: ${steps.join(', ')}`);
    assert.ok(!steps.includes('upserting'), `preview reached the upsert step: ${steps.join(', ')}`);
    assert.ok(!steps.includes('saving'),    `preview reached the registry save: ${steps.join(', ')}`);
  });

  test('a non-boolean dryRun is a real ingest, not a preview', async () => {
    // Strict `=== true`. A truthy string arriving from a query param or an
    // untyped client must not silently turn a requested ingest into a no-op
    // that reports success — the document would appear to have been ingested
    // and never be there.
    const { ingestDocumentHandler } = await import('./kb-routes');
    const events = await readEvents(
      await ingestDocumentHandler(authed({ ...validBody, dryRun: 'true' })),
    );

    assert.equal(
      done(events)?.data['dryRun'],
      undefined,
      "dryRun: 'true' (string) was treated as a preview",
    );
    // It took the write path, which cannot succeed against a fake Pinecone key.
    assert.ok(
      events.some((e) => e.event === 'error'),
      'expected the real ingest path to fail against fake credentials',
    );
  });
});

describe('POST /kb/documents — a preview bypasses nothing', () => {
  test('still requires the admin key', async () => {
    const { ingestDocumentHandler } = await import('./kb-routes');
    const res = await ingestDocumentHandler(makeCtx({ ...validBody, dryRun: true }));
    assert.equal(res.status, 401);
  });

  test('rejects a wrong admin key', async () => {
    const { ingestDocumentHandler } = await import('./kb-routes');
    const res = await ingestDocumentHandler(
      makeCtx({ ...validBody, dryRun: true }, { 'x-episteme-admin-key': 'wrong' }),
    );
    assert.equal(res.status, 401);
  });

  test('still validates the namespace', async () => {
    const { ingestDocumentHandler } = await import('./kb-routes');
    const res = await ingestDocumentHandler(
      authed({ ...validBody, namespace: 'platform-admin', dryRun: true }),
    );
    assert.equal(res.status, 400);
    assert.match(String((await res.json() as { error: string }).error), /Invalid namespace/);
  });

  test('still rejects an absent updatedAt', async () => {
    const { ingestDocumentHandler } = await import('./kb-routes');
    const { updatedAt: _omitted, ...noDate } = validBody;
    const res = await ingestDocumentHandler(authed({ ...noDate, dryRun: true }));
    assert.equal(res.status, 400);
    assert.match(String((await res.json() as { error: string }).error), /updatedAt/);
  });

  test('accepts an explicitly undated source', async () => {
    const { ingestDocumentHandler } = await import('./kb-routes');
    const events = await readEvents(
      await ingestDocumentHandler(authed({ ...validBody, updatedAt: null, dryRun: true })),
    );
    const report = done(events)?.data['report'] as Record<string, unknown>;
    assert.equal(report['updatedAt'], null, 'an undated source must not be stamped with a date');
  });
});
