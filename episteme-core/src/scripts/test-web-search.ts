// Read-only isolation test for the web-search tier (Tavily). Bypasses the agent
// and the KB/news cascade — calls searchWeb() directly so you can see exactly
// what Tavily returns, which domains, and each result's score vs the threshold.
// No writes. Run with env loaded by Node itself (contents never printed):
//   node --env-file=.env.local --import tsx src/scripts/test-web-search.ts
import { searchWeb, buildWebContext } from '../mastra/tools/web-search-tool';
import { WEB_SEARCH_CONFIG } from '../mastra/config';

const QUERIES = [
  'What is TETFund and what does it fund?',
  'What is the JAMB registration deadline?',
  'What is the NUC role in Nigerian universities?',
];

async function main() {
  console.log('TAVILY key present:', Boolean(process.env.TAVILY_API_KEY));
  console.log('include_domains:', WEB_SEARCH_CONFIG.includeDomains.join(', ') || '(whole web)');
  console.log('scoreThreshold:', WEB_SEARCH_CONFIG.scoreThreshold, ' depth:', WEB_SEARCH_CONFIG.searchDepth);

  for (const q of QUERIES) {
    console.log('\n' + '='.repeat(70));
    console.log('QUERY:', q);
    try {
      const res = await searchWeb(q);
      if (!res.found) {
        console.log('  found=false —', res.message);
        continue;
      }
      for (const r of res.results) {
        console.log(`  score=${r.score?.toFixed(3)}  ${r.url}`);
        console.log(`     ${r.title}`);
      }
      console.log('\n  --- context handed to the model ---');
      console.log(buildWebContext(res.results).split('\n').slice(0, 6).map((l) => '  ' + l).join('\n'));
    } catch (e) {
      console.error('  ERROR:', (e as Error).message);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
