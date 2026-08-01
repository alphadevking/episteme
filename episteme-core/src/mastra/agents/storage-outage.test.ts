// episteme-core/src/mastra/agents/storage-outage.test.ts
/**
 * Regression guard: a chat turn must never await a network-backed store.
 *
 * THE INCIDENT (2026-08-01): LIBSQL_URL pointed at a Turso database that
 * stopped resolving. Every POST /chat/:agentId returned 500 in ~25ms, before
 * any model call:
 *
 *   Error executing step workflow.execution-workflow.step.prepare-memory-step
 *     at LibSQLDB.createTable → MemoryLibSQL.init → LibSQLStore.init
 *
 * THE PART THAT IS EASY TO GET WRONG: removing the agent's Memory is NOT
 * sufficient. Mastra persists an agent's execution-workflow run BEFORE the
 * first step executes, so a memory-less agent still hits storage:
 *
 *   MASTRA_STORAGE_LIBSQL_CREATE_TABLE_FAILED { tableName: 'mastra_scorers' }
 *     at ensureInit → Workflow.getWorkflowRunById → Workflow.createRun
 *
 * Measured against a dead endpoint, that path does not even reject cleanly —
 * the returned stream never settles, so the turn hangs until the platform
 * timeout. Storage is therefore a hard dependency of every turn, and the only
 * durable fix is for the store in that path to be one that cannot be
 * unreachable: a local file (db.ts, resolveRuntimeDbUrl).
 *
 * These tests pin both halves of that: the runtime store is never remote, and a
 * turn backed by it completes. No credentials and no network — the model is a
 * mock and the store is a temp file.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { LibSQLStore } from '@mastra/libsql';
import { createClient } from '@libsql/client';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { resolveRuntimeDbUrl } from '../db';

describe('resolveRuntimeDbUrl', () => {
  /**
   * The load-bearing property. LIBSQL_URL is the durable KB database; the
   * runtime store must never follow it to a remote host, because that is
   * precisely the coupling that turned a database outage into a chat outage.
   */
  test('never returns a remote URL, even when LIBSQL_URL is remote', () => {
    const remote = 'libsql://episteme-prod.turso.io';
    for (const env of [
      { LIBSQL_URL: remote },
      { LIBSQL_URL: remote, VERCEL: '1' },
      { LIBSQL_URL: remote, AWS_LAMBDA_FUNCTION_NAME: 'fn' },
    ] as NodeJS.ProcessEnv[]) {
      const url = resolveRuntimeDbUrl(env);
      assert.ok(url.startsWith('file:'), `expected a local file URL, got ${url}`);
    }
  });

  test('uses /tmp on serverless platforms, where the bundle dir is read-only', () => {
    assert.equal(resolveRuntimeDbUrl({ VERCEL: '1' }), 'file:/tmp/mastra.db');
    assert.equal(resolveRuntimeDbUrl({ AWS_LAMBDA_FUNCTION_NAME: 'fn' }), 'file:/tmp/mastra.db');
  });

  test('uses the project directory locally', () => {
    assert.equal(resolveRuntimeDbUrl({}), 'file:./mastra.db');
  });

  test('honours the explicit MASTRA_RUNTIME_DB_URL escape hatch', () => {
    assert.equal(
      resolveRuntimeDbUrl({ MASTRA_RUNTIME_DB_URL: 'file:/custom/path.db', VERCEL: '1' }),
      'file:/custom/path.db',
    );
  });
});

describe('a chat turn on the runtime store', () => {
  let dir: string;
  let client: ReturnType<typeof createClient> | undefined;

  before(async () => { dir = await mkdtemp(join(tmpdir(), 'episteme-store-')); });
  after(async () => {
    client?.close();
    // Best-effort. Windows can hold the .db locked past client.close() (EBUSY),
    // and a temp file the OS will reap must never fail the suite — this hook
    // guards nothing, unlike the assertions below.
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      .catch(() => {});
  });

  /**
   * The mechanism test: with the runtime store local, a turn completes even
   * though LIBSQL_URL points at an endpoint that is guaranteed to fail. Before
   * the split, this same scenario hung until the 30s function timeout.
   */
  test('completes while the remote KB database is unreachable', async () => {
    process.env['LIBSQL_URL'] = 'http://127.0.0.1:1'; // undici: instant "bad port"

    const agent = new Agent({
      id: 'no-memory-agent',
      name: 'No Memory Agent',
      instructions: 'Reply briefly.',
      model: new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'hello' },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ] as never,
          }),
        }),
      }),
    });

    client = createClient({ url: `file:${join(dir, 'runtime.db')}` });
    const mastra = new Mastra({
      agents: { agent },
      storage: new LibSQLStore({ id: 'runtime-store', client }),
      logger: false,
    });

    const result = await mastra
      .getAgentById('no-memory-agent')
      .stream([{ role: 'user', content: 'hi' }]);

    let text = '';
    for await (const chunk of result.textStream) text += chunk;
    assert.equal(text, 'hello');
  });
});

describe('episteme chat agent configuration', () => {
  let epistemeChatAgent: Agent;

  before(async () => {
    // The agent's tool graph builds provider clients at MODULE scope and throws
    // on missing env (knowledge-retrieval-tool → Pinecone, embedder →
    // ModelRouterEmbeddingModel). Placeholders only — nothing here calls out.
    process.env['PINECONE_API_KEY'] ??= 'test-key';
    process.env['PINECONE_INDEX']   ??= 'test-index';
    process.env['MISTRAL_API_KEY']  ??= 'test-key';
    ({ epistemeChatAgent } = await import('./episteme-chat-agent'));
  });

  /**
   * Memory is not the whole fix (see the header), but it is the one piece a
   * future change is most likely to reintroduce casually. Attaching a Memory
   * puts a storage round-trip ahead of the first token and requires the chat
   * proxy to start sending `memory: { thread, resource }` — neither of which
   * should happen by accident.
   */
  test('has no memory attached', async () => {
    assert.equal(await epistemeChatAgent.getMemory(), undefined);
  });
});
