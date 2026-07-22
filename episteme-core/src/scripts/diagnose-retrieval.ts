// Read-only retrieval probe. Embeds a query with the SAME model the app uses and
// queries every namespace a staff-role caller can see, printing each match's
// score + which document + ingestedAt/updatedAt, so we can see exactly why a
// time-sensitive query (e.g. "who is the VC now") resolves to a stale KB doc.
// No writes. Run with env loaded by Node itself (contents never printed):
//   node --env-file=.env.local --import tsx src/scripts/diagnose-retrieval.ts
import { Pinecone } from '@pinecone-database/pinecone';
import { embedTexts } from '../mastra/ingestion/embedder';
import { RETRIEVAL_CONFIG } from '../mastra/config';

const QUERIES = [
  'who is the current vice chancellor of the University of Benin',
  'who is the vice chancellor now',
];
// Namespaces a staff/trust-4 caller can search.
const NAMESPACES = ['general', 'academic-policy', 'admissions', 'programmes', 'financial-aid'];

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const index = pc.index({ name: process.env.PINECONE_INDEX! });

function isDaysOld(iso: string, days: number): boolean {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24) > days;
}

async function main() {
  console.log('relevanceThreshold =', RETRIEVAL_CONFIG.relevanceThreshold,
              ' freshnessThresholdDays =', RETRIEVAL_CONFIG.freshnessThresholdDays);

  for (const q of QUERIES) {
    console.log('\n' + '='.repeat(78));
    console.log('QUERY:', q);
    const [vec] = await embedTexts([q]);

    const all: Array<{ score: number; ns: string; m: Record<string, unknown> }> = [];
    for (const ns of NAMESPACES) {
      const res = await index.namespace(ns).query({ vector: vec, topK: 5, includeMetadata: true });
      for (const match of res.matches) {
        if (match.metadata) all.push({ score: match.score ?? 0, ns, m: match.metadata as Record<string, unknown> });
      }
    }
    all.sort((a, b) => b.score - a.score);

    for (const { score, ns, m } of all.slice(0, 8)) {
      // Staleness is measured from the CONTENT date (updatedAt), matching the app
      // (knowledge-retrieval-tool.ts). ingestedAt is audit-only and NOT used here.
      const contentDate = m['updatedAt'] as string;
      const clears = score >= RETRIEVAL_CONFIG.relevanceThreshold ? 'PASS' : 'below';
      const stale  = isDaysOld(contentDate, RETRIEVAL_CONFIG.freshnessThresholdDays) ? 'STALE' : 'fresh';
      console.log(`  ${score.toFixed(3)} [${clears}/${stale}] ns=${ns} src=${String(m['source']).slice(0, 48)}`);
      console.log(`        updatedAt(content)=${m['updatedAt']}  ingestedAt(audit)=${m['ingestedAt'] ?? '(none)'}`);
    }

    // Simulate the cascade's decision: top match stale ⇒ it defers to news/web.
    const top = all[0];
    if (top) {
      const topStale = isDaysOld(top.m['updatedAt'] as string, RETRIEVAL_CONFIG.freshnessThresholdDays);
      const topRelevant = top.score >= RETRIEVAL_CONFIG.relevanceThreshold;
      console.log(`  → top match relevant=${topRelevant} stale=${topStale} ⇒ ${
        !topRelevant ? 'KB misses → cascade falls to news/web'
        : topStale   ? 'KB stale → cascade DEFERS to news/web (returns KB+caveat only if both miss)'
        :              'KB fresh → returns KB directly'
      }`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
