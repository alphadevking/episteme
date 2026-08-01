/**
 * LibSQL clients for episteme-core. There are deliberately TWO, split by what
 * an outage of each would cost.
 *
 * WHY THE SPLIT (incident 2026-08-01):
 *   A single remote client backed everything. When the Turso host stopped
 *   resolving, every POST /chat/:agentId returned 500 in ~25ms — before any
 *   model call — because Mastra persists an agent's execution-workflow run to
 *   storage BEFORE the first step runs (Workflow.createRun → ensureInit →
 *   createTable). Nothing in an answer reads that data: retrieval is Pinecone
 *   plus on-disk platform docs, and conversation history is owned by Supabase
 *   and replayed by the chat proxy each turn. A store that no answer depends on
 *   was taking every answer down with it.
 *
 *   `runtimeClient` therefore points at a LOCAL file, which cannot be
 *   unreachable. A chat turn now touches only the local filesystem, so remote
 *   database availability is no longer in the request path at all.
 *
 * kbClient — DURABLE. The kb_documents registry (kb-store.ts): what has been
 *   ingested, its scope, freshness, and version. Must survive instance
 *   recycling and be shared across instances, so it stays remote (Turso) in
 *   production. Used only by admin/ingestion routes — never by a chat turn.
 *   If it is down, ingestion and the KB admin UI fail loudly; chat is fine.
 *
 * runtimeClient — EPHEMERAL. Mastra's own runtime tables: workflow runs,
 *   observability traces, scorer results. Per-instance and disposable by
 *   design. On Vercel only /tmp is writable, hence the platform check.
 *
 * TRADE-OFF, stated plainly: production traces and scores now live and die with
 * the instance that produced them, so Studio's Observability tab in production
 * shows only the current instance's history. Local development is unchanged
 * (./mastra.db), which is where evals and experiments actually read traces from.
 * Chat availability was judged worth more than cross-instance prod traces; to
 * revisit, set MASTRA_RUNTIME_DB_URL to a remote URL and accept that a remote
 * outage becomes a chat outage again.
 */
import { createClient, type Client } from '@libsql/client';

/**
 * True on Vercel (and other read-only-FS serverless platforms), where the
 * bundle directory cannot be written but /tmp can.
 */
function isServerless(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['VERCEL'] || env['AWS_LAMBDA_FUNCTION_NAME']);
}

/**
 * Where Mastra's ephemeral runtime tables live.
 *
 * Exported for tests: the guarantee "a chat turn never awaits a network store"
 * is only as good as this function never returning a remote URL by accident.
 * MASTRA_RUNTIME_DB_URL is the deliberate, greppable escape hatch — note that
 * pointing it at a remote host knowingly re-couples chat availability to that
 * host. LIBSQL_URL is intentionally NOT consulted here; that variable is the
 * durable KB database, and reading it here is exactly the coupling that caused
 * the outage.
 */
export function resolveRuntimeDbUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['MASTRA_RUNTIME_DB_URL'];
  if (explicit) return explicit;
  return isServerless(env) ? 'file:/tmp/mastra.db' : 'file:./mastra.db';
}

const kbUrl      = process.env['LIBSQL_URL'] ?? 'file:./mastra.db';
const runtimeUrl = resolveRuntimeDbUrl();

/** Durable, remote in production. KB registry only — never a chat turn. */
export const kbClient: Client = createClient({
  url: kbUrl,
  authToken: process.env['LIBSQL_AUTH_TOKEN'],
});

/**
 * Ephemeral, always local. Mastra workflow runs, traces, scorer results.
 *
 * In local development both URLs are ./mastra.db, exactly as before this split.
 * They share ONE connection there: two libsql clients writing the same SQLite
 * file would contend for the write lock (SQLITE_BUSY) — a problem the single
 * pre-split client never had, and one no one should have to debug for a change
 * that is only about production topology.
 */
export const runtimeClient: Client =
  runtimeUrl === kbUrl ? kbClient : createClient({ url: runtimeUrl });
