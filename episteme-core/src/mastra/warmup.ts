// Connection warm-up — fire-and-forget at server boot.
//
// Measured: the FIRST retrieval after a (re)start paid ~6s (TLS/connection
// setup to the Mistral embed API and Pinecone), while warm steady-state is
// ~1.5s. Paying that setup cost at boot instead of on the first user's query
// keeps the first real answer as fast as every other one.
//
// Deliberately non-blocking and failure-tolerant: a warm-up error (missing env
// during build, network hiccup) is logged and ignored — it must never affect
// server startup.
import { Pinecone } from '@pinecone-database/pinecone';
import { embedTexts } from './ingestion/embedder';
import { kbClient } from './db';

/**
 * Boot probe for the DURABLE KB database.
 *
 * Chat no longer depends on this database (see db.ts), which is the point — but
 * "no longer takes chat down" must not become "fails silently". Ingestion and
 * the KB admin UI do depend on it, and on 2026-08-01 the first sign that it was
 * unreachable was a wave of production 500s. This turns that into one loud line
 * in the boot log.
 *
 * Deliberately non-blocking and non-fatal: an unreachable KB database must not
 * prevent the server from serving chat.
 */
function probeKbDatabase(): void {
  setTimeout(async () => {
    try {
      await kbClient.execute('SELECT 1');
      console.info('[boot] KB database reachable');
    } catch (err) {
      console.error(
        '[boot] KB DATABASE UNREACHABLE — ingestion and the KB admin UI will fail. ' +
        'Chat is unaffected. Check LIBSQL_URL / LIBSQL_AUTH_TOKEN.',
        (err as Error).message,
      );
    }
  }, 0);
}

export function warmupConnections(): void {
  probeKbDatabase();
  setTimeout(async () => {
    const t = Date.now();
    try {
      const [vec] = await embedTexts(['warmup']);

      const apiKey    = process.env['PINECONE_API_KEY'];
      const indexName = process.env['PINECONE_INDEX'];
      if (apiKey && indexName) {
        const pc = new Pinecone({ apiKey });
        await pc.index({ name: indexName }).namespace('general').query({ vector: vec, topK: 1 });
      }

      console.info(`[warmup] embed + pinecone connections warmed in ${Date.now() - t}ms`);
    } catch (err) {
      console.warn('[warmup] skipped:', (err as Error).message);
    }
  }, 0);
}
