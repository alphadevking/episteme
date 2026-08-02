#!/usr/bin/env tsx
// scripts/harvest.ts
/**
 * The uniben.edu prose harvest runner.
 *
 *   pnpm harvest fetch              # phase 1 — free, validates every URL
 *   pnpm harvest preview            # phase 2 — 1 Unstructured call per sampled page
 *   pnpm harvest preview --all
 *   pnpm harvest commit --confirm   # phase 3 — writes
 *
 * pnpm forwards trailing args to the script as-is. If a flag ever gets eaten by
 * the package manager, `pnpm harvest -- commit --confirm` is the explicit form.
 *
 * The phases exist because they cost different amounts, and the cheapest one
 * catches the most common failure:
 *
 *   fetch    0 Unstructured calls   proxy + cleanPageHtml only. Catches dead
 *                                   URLs, Cloudflare blocks, and pages that
 *                                   cleaning strips to nothing.
 *   preview  1 call per page        runs the real pipeline through chunking and
 *                                   stops before any write. Catches bad
 *                                   chunking and wrong scope.
 *   commit   1 call per page        ingests.
 *
 * So the efficient order is: fetch all pages (free), preview a handful, commit
 * all. These pages share one CMS template, so chunking proven on a sample holds
 * for the rest — previewing all 26 would pay twice for every page to learn the
 * same thing. `--all` is there for when that assumption stops holding.
 *
 * Nothing here decides what may be ingested. The URL allowlist, the host check,
 * and the admin key all live in core; this runner cannot widen any of them.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MANIFEST,
  validateManifest,
  toIngestBody,
  docIdFromUrl,
  type HarvestEntry,
} from '../lib/harvest/manifest';
import { parseRobotsTxt, type RobotsTxt } from '../lib/harvest/robots';
// The crawl's manners live in one module, shared with the admin harvest UI.
// Two implementations of "may we fetch this" is how a UI ends up politer or
// ruder than the CLI without anyone choosing that. See lib/harvest/gate.ts.
import { USER_AGENT, isThin, originOf, textLengthOf, verdictFor } from '../lib/harvest/gate';
import { bucketSample } from '../lib/harvest/plan';

const CORE_BASE = process.env.MASTRA_BASE_URL ?? 'http://localhost:4111';
const ADMIN_KEY = process.env.MASTRA_ADMIN_KEY;
const INSTITUTION_ID = process.env.HARVEST_INSTITUTION_ID;

const OUT_DIR = join(process.cwd(), '.harvest');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-episteme-admin-key': ADMIN_KEY!,
  };
  if (INSTITUTION_ID) h['x-episteme-institution-id'] = INSTITUTION_ID;
  return h;
}

// ── Core calls ───────────────────────────────────────────────────────────────

interface FetchResult { url: string; contentHash: string; html: string }

async function coreFetch(url: string): Promise<FetchResult> {
  const res = await fetch(`${CORE_BASE}/kb/fetch`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ url }),
  });
  const body = await res.json() as Partial<FetchResult> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as FetchResult;
}

interface SseEvent { event: string; data: Record<string, unknown> }

/** POST /kb/documents streams SSE; collect it. */
async function coreIngest(entry: HarvestEntry, dryRun: boolean): Promise<SseEvent[]> {
  const res = await fetch(`${CORE_BASE}/kb/documents`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(toIngestBody(entry, dryRun)),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  const events: SseEvent[] = [];
  for (const block of text.split('\n\n')) {
    const match = block.match(/^event: (.+)\ndata: ([\s\S]+)$/);
    if (match) events.push({ event: match[1]!, data: JSON.parse(match[2]!) });
  }
  return events;
}

// ── robots.txt ───────────────────────────────────────────────────────────────

const robotsCache = new Map<string, RobotsTxt | null>();

/**
 * Fetch and parse robots.txt for a host, through the same proxy.
 *
 * Returns null when it could not be read, and callers treat null as "skip
 * every page on this host". Fail closed: proceeding because robots.txt happened
 * to be unreachable is exactly how a well-meaning crawler ends up somewhere it
 * was told not to go.
 */
async function robotsFor(hostUrl: string): Promise<RobotsTxt | null> {
  const origin = originOf(hostUrl);
  if (robotsCache.has(origin)) return robotsCache.get(origin)!;

  let parsed: RobotsTxt | null = null;
  try {
    const { html } = await coreFetch(`${origin}/robots.txt`);
    parsed = parseRobotsTxt(html, USER_AGENT);
    const rules = parsed.rules.length;
    console.log(`  robots.txt ${origin} — ${rules} rule${rules === 1 ? '' : 's'}${parsed.crawlDelay ? `, crawl-delay ${parsed.crawlDelay}s` : ''}`);
  } catch (err) {
    console.log(`  robots.txt ${origin} — UNREADABLE (${(err as Error).message})`);
  }

  robotsCache.set(origin, parsed);
  return parsed;
}

/** Gate one URL on robots, reporting the reason when it is refused. */
async function permitted(url: string): Promise<{ ok: boolean; reason?: string; delayMs: number }> {
  const verdict = verdictFor(await robotsFor(url), url);
  return { ok: verdict.allowed, reason: verdict.reason, delayMs: verdict.delayMs };
}

// ── Phases ───────────────────────────────────────────────────────────────────

interface PhaseRow {
  url: string;
  docId: string;
  status: 'ok' | 'skipped' | 'failed';
  detail: string;
}

async function phaseFetch(entries: HarvestEntry[]): Promise<PhaseRow[]> {
  await mkdir(OUT_DIR, { recursive: true });
  const rows: PhaseRow[] = [];

  for (const entry of entries) {
    const docId = docIdFromUrl(entry.url);
    const gate = await permitted(entry.url);
    if (!gate.ok) {
      rows.push({ url: entry.url, docId, status: 'skipped', detail: gate.reason! });
      console.log(`SKIP  ${entry.url}\n      ${gate.reason}`);
      // No sleep: a skip made no request to the origin, so there is nothing to
      // pace. Sleeping here turns a fully-blocked run into a minute of waiting
      // to report that it did nothing.
      continue;
    }

    try {
      const page = await coreFetch(entry.url);
      // Text length after tag-stripping approximates what the extractor will
      // see. A page that cleans down to almost nothing is the failure this
      // phase exists to catch, and it is invisible in the byte count.
      const textLength = textLengthOf(page.html);
      await writeFile(join(OUT_DIR, `${docId}.html`), page.html, 'utf8');

      const thin = isThin(textLength);
      rows.push({
        url: entry.url,
        docId,
        status: thin ? 'failed' : 'ok',
        detail: `${textLength} chars of text${thin ? ' — TOO THIN, cleaning likely stripped the content' : ''}`,
      });
      console.log(`${thin ? 'THIN ' : 'OK   '} ${entry.url}\n      ${textLength} chars → .harvest/${docId}.html`);
    } catch (err) {
      rows.push({ url: entry.url, docId, status: 'failed', detail: (err as Error).message });
      console.log(`FAIL  ${entry.url}\n      ${(err as Error).message}`);
    }

    await sleep(gate.delayMs);
  }

  return rows;
}

async function phaseIngest(entries: HarvestEntry[], dryRun: boolean): Promise<PhaseRow[]> {
  const rows: PhaseRow[] = [];

  for (const entry of entries) {
    const docId = docIdFromUrl(entry.url);
    const gate = await permitted(entry.url);
    if (!gate.ok) {
      rows.push({ url: entry.url, docId, status: 'skipped', detail: gate.reason! });
      console.log(`SKIP  ${entry.url} — ${gate.reason}`);
      continue; // No request made — nothing to pace. See phaseFetch.
    }

    try {
      const events = await coreIngest(entry, dryRun);
      const failed = events.find((e) => e.event === 'error');
      if (failed) throw new Error(String(failed.data.error));

      const done = events.find((e) => e.event === 'done');
      if (!done) throw new Error('stream ended without a done event');

      if (dryRun) {
        const r = done.data.report as Record<string, unknown>;
        const detail =
          `${r.parentChunks} parents / ${r.childChunks} chunks, ${r.textLength} chars, ` +
          `ns=${r.namespace} roles=${(r.roles as string[]).join(',')}` +
          (r.replacesExisting ? ' [REPLACES EXISTING]' : '') +
          (r.movesFromNamespace ? ` [MOVES FROM ${r.movesFromNamespace}]` : '');
        rows.push({ url: entry.url, docId, status: 'ok', detail });
        console.log(`\n── ${entry.source}\n   ${entry.url}\n   ${detail}`);
        for (const sample of (r.sampleChunks as { index: number; length: number; text: string }[])) {
          console.log(`\n   [chunk ${sample.index}, ${sample.length} chars]`);
          console.log(`   ${sample.text.replace(/\s+/g, ' ').slice(0, 400)}…`);
        }
      } else {
        const audit = done.data.audit as Record<string, unknown>;
        const detail = `${audit.vectorsUpserted} vectors into ${audit.namespace}`;
        rows.push({ url: entry.url, docId, status: 'ok', detail });
        console.log(`OK    ${entry.url} — ${detail}`);
      }
    } catch (err) {
      rows.push({ url: entry.url, docId, status: 'failed', detail: (err as Error).message });
      console.log(`FAIL  ${entry.url}\n      ${(err as Error).message}`);
    }

    await sleep(gate.delayMs);
  }

  return rows;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Exit code for a phase. Non-zero means "do not proceed to the next phase". */
function summarize(rows: PhaseRow[]): number {
  const ok = rows.filter((r) => r.status === 'ok').length;
  const skipped = rows.filter((r) => r.status === 'skipped').length;
  const failed = rows.filter((r) => r.status === 'failed');

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`${ok} ok · ${skipped} skipped · ${failed.length} failed`);
  if (failed.length) {
    console.log('\nFailed:');
    for (const row of failed) console.log(`  ${row.url}\n    ${row.detail}`);
    console.log('\nRemove or fix these in lib/harvest/manifest.ts before committing.');
  }

  // A run that accomplished nothing must not exit 0. Every page being skipped
  // is the shape of a misconfiguration — core unreachable, wrong admin key,
  // robots.txt unfetchable — and reporting success for it means a scripted
  // `fetch && preview && commit` chain marches straight past the problem.
  if (ok === 0 && rows.length > 0) {
    console.log('\nNothing succeeded. Check that core is running and reachable at the URL above.');
    return 1;
  }
  return failed.length;
}

async function main(): Promise<void> {
  const [phase, ...flags] = process.argv.slice(2);
  const all = flags.includes('--all');
  const confirmed = flags.includes('--confirm');

  if (!ADMIN_KEY) {
    // Deliberately NOT auto-loaded from .env.local. `commit` writes to the KB,
    // and which environment it writes to should be a choice the operator makes
    // out loud, not one a dotfile makes for them.
    console.error('MASTRA_ADMIN_KEY is not set.\n');
    console.error('Supply it for this run, e.g.:');
    console.error('  MASTRA_ADMIN_KEY=<key> pnpm harvest fetch');
    console.error('  MASTRA_ADMIN_KEY=<key> MASTRA_BASE_URL=http://localhost:4111 pnpm harvest fetch\n');
    console.error('It is the same key episteme-chat sends as x-episteme-admin-key.');
    console.error(`Optional: HARVEST_INSTITUTION_ID=<uuid> to scope the ingest to one tenant`);
    console.error('(omit it and every document is tagged GLOBAL, visible to all institutions).');
    process.exit(1);
  }

  const problems = validateManifest();
  if (problems.length) {
    console.error('The manifest is invalid — nothing was fetched:\n');
    for (const p of problems) console.error(`  ${p.url}\n    ${p.problem}`);
    process.exit(1);
  }
  console.log(`Manifest: ${MANIFEST.length} entries, all valid.`);
  console.log(`Core: ${CORE_BASE}${INSTITUTION_ID ? ` · institution ${INSTITUTION_ID}` : ' · GLOBAL (no institution header)'}\n`);

  let rows: PhaseRow[];

  switch (phase) {
    case 'fetch':
      rows = await phaseFetch(MANIFEST);
      break;

    case 'preview': {
      // One page per (host, namespace) unless --all: pages sharing a template
      // and a scope chunk alike, so a second sample from the same bucket costs
      // an Unstructured call to re-learn what the first already showed.
      const sample = all ? MANIFEST : bucketSample(MANIFEST, (e) => e);
      console.log(`Previewing ${sample.length} of ${MANIFEST.length} entries (${sample.length} Unstructured calls).`);
      console.log(all ? '' : 'One per host+namespace. Use --all to preview every page.\n');
      rows = await phaseIngest(sample, true);
      break;
    }

    case 'commit':
      if (!confirmed) {
        console.error('commit writes to Pinecone and the registry. Re-run with --confirm.');
        console.error(`It would ingest ${MANIFEST.length} documents (${MANIFEST.length} Unstructured calls).`);
        process.exit(1);
      }
      rows = await phaseIngest(MANIFEST, false);
      break;

    default:
      console.error('Usage: pnpm harvest <fetch|preview|commit> [--all] [--confirm]');
      process.exit(1);
  }

  const failures = summarize(rows);
  await writeFile(
    join(OUT_DIR, `${phase}-report.json`),
    JSON.stringify(rows, null, 2),
    'utf8',
  ).catch(() => {});

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
