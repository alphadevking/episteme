/**
 * Shared LibSQL client — single connection for all storage in episteme-core.
 *
 * Passed to Mastra's LibSQLStore (observability, memory, scores, etc.)
 * and used directly by the KB document registry (kb-store.ts).
 *
 * Uses resolveClient from @mastra/libsql — no extra dependency needed.
 * Override the DB path via LIBSQL_URL (e.g. for Turso in production).
 */
import { createClient } from '@libsql/client';

declare const process: { env: Record<string, string | undefined> };

const url       = process.env['LIBSQL_URL']        ?? 'file:./mastra.db';
const authToken = process.env['LIBSQL_AUTH_TOKEN'];

export const dbClient = createClient({ url, authToken });
