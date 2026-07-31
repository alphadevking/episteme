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

export function warmupConnections(): void {
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
