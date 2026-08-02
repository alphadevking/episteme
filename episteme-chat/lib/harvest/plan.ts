// lib/harvest/plan.ts
/**
 * Run planning for a harvest — which pages are eligible for which phase, and
 * what a row's state means.
 *
 * The admin harvest UI drives the same three phases as `pnpm harvest`
 * (validate → preview → commit), but it has something the CLI does not: state
 * that survives between phases. The CLI re-derives everything on each
 * invocation and cheerfully commits a page whose fetch failed ten minutes ago;
 * the UI knows that row failed and can refuse to commit it.
 *
 * That extra strictness is the one deliberate difference between the two, and
 * it lives here rather than in the page component so it can be tested without
 * a browser. Everything else — robots gating, thinness, the preview sample
 * rule — is shared code, so the UI and CLI cannot drift on the decisions that
 * touch the outside world.
 */
import {
  docIdFromUrl,
  type ContentType,
  type HarvestEntry,
  type Namespace,
  type Role,
} from './manifest';

// ── Row state ────────────────────────────────────────────────────────────────

/**
 * Where one page has got to.
 *
 * `skipped` is separate from `failed` on purpose: robots.txt refusing a page
 * is the system working, not breaking, and an operator scanning a run should
 * not have to read the detail text to tell those apart.
 */
export type RowPhase =
  | 'queued'
  | 'validating'
  | 'validated'
  | 'previewing'
  | 'previewed'
  | 'committing'
  | 'committed'
  | 'skipped'
  | 'failed';

/** Chunk counts and scope from a dry run — what a commit would actually write. */
export interface PreviewReport {
  parentChunks: number;
  childChunks: number;
  textLength: number;
  namespace: string;
  roles: string[];
  replacesExisting: boolean;
  movesFromNamespace: string | null;
  sampleChunks: { index: number; length: number; text: string }[];
}

export interface HarvestRow {
  entry: HarvestEntry;
  /** Derived from the URL, so a re-harvest updates in place. See docIdFromUrl. */
  docId: string;
  phase: RowPhase;
  /** One line of human detail for the current phase. Empty when there is none. */
  detail: string;
  /** Visible-text length from validation; null until validated. */
  textLength: number | null;
  /** Populated by preview. Kept after commit so the run stays reviewable. */
  report: PreviewReport | null;
  /** Vectors written, set on commit. */
  vectorsUpserted: number | null;
}

export function buildRows(entries: HarvestEntry[]): HarvestRow[] {
  return entries.map((entry) => ({
    entry,
    docId: docIdFromUrl(entry.url),
    phase: 'queued' as RowPhase,
    detail: '',
    textLength: null,
    report: null,
    vectorsUpserted: null,
  }));
}

// ── Phase eligibility ────────────────────────────────────────────────────────

export type Phase = 'validate' | 'preview' | 'commit';

/**
 * Phases a row may enter, by the phase it is currently in.
 *
 * Validation only picks up rows that have not passed it — re-running validate
 * must not knock an already-previewed row back down to `validated` and quietly
 * discard its report. Per-row retry is how you re-check a specific page.
 *
 * Preview and commit both require a row to have passed validation. That is the
 * strictness the CLI cannot have: it means a page whose fetch failed can never
 * reach an Unstructured call or a write, in this run or a later one, without
 * someone fixing it first.
 */
const ELIGIBLE: Record<Phase, ReadonlySet<RowPhase>> = {
  validate: new Set<RowPhase>(['queued', 'failed', 'skipped']),
  preview: new Set<RowPhase>(['validated', 'previewed']),
  commit: new Set<RowPhase>(['validated', 'previewed']),
};

export function eligibleFor(rows: HarvestRow[], phase: Phase): HarvestRow[] {
  return rows.filter((row) => ELIGIBLE[phase].has(row.phase));
}

export function canEnter(phase: Phase, current: RowPhase): boolean {
  return ELIGIBLE[phase].has(current);
}

/**
 * Which pages to preview when not previewing all of them.
 *
 * One per (host, namespace): pages sharing a CMS template and a scope chunk
 * alike, so a second sample from the same bucket costs an Unstructured call to
 * re-learn what the first already showed.
 *
 * Generic over the item so the CLI can sample entries and the UI can sample
 * rows through the same function. The sample the UI previews is then provably
 * the sample the CLI would have previewed, rather than two rules that happen
 * to agree today.
 */
export function bucketSample<T>(
  items: T[],
  entryOf: (item: T) => { url: string; namespace: string },
): T[] {
  const byBucket = new Map<string, T>();
  for (const item of items) {
    const { url, namespace } = entryOf(item);
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      host = url;
    }
    const key = `${host}|${namespace}`;
    if (!byBucket.has(key)) byBucket.set(key, item);
  }
  return [...byBucket.values()];
}

// ── Summary ──────────────────────────────────────────────────────────────────

export interface RunSummary {
  total: number;
  queued: number;
  validated: number;
  previewed: number;
  committed: number;
  skipped: number;
  failed: number;
  /** True while any row is mid-flight. */
  running: boolean;
}

const IN_FLIGHT: ReadonlySet<RowPhase> = new Set<RowPhase>([
  'validating',
  'previewing',
  'committing',
]);

/**
 * True while a row has a request out.
 *
 * An in-flight row is eligible for nothing and, if a run is interrupted, must
 * be put back somewhere retryable — leaving it here would show progress that
 * no longer has anything working on it.
 */
export function isInFlight(phase: RowPhase): boolean {
  return IN_FLIGHT.has(phase);
}

export function summarize(rows: HarvestRow[]): RunSummary {
  const count = (phase: RowPhase) => rows.filter((r) => r.phase === phase).length;
  return {
    total: rows.length,
    queued: count('queued'),
    validated: count('validated'),
    previewed: count('previewed'),
    committed: count('committed'),
    skipped: count('skipped'),
    failed: count('failed'),
    running: rows.some((r) => IN_FLIGHT.has(r.phase)),
  };
}

// ── Ad-hoc entries ───────────────────────────────────────────────────────────

/** Classification applied to every URL pasted into the ad-hoc box. */
export interface AdHocClassification {
  namespace: Namespace;
  category: Namespace;
  roles: Role[];
  faculty: string;
  contentType: ContentType;
  /**
   * The pages' own content date, or null when they show none.
   *
   * Null is the honest default and the manifest's near-universal choice:
   * stamping today's date marks a page permanently fresh and turns the
   * staleness signal into a lie. See HarvestEntry.updatedAt.
   */
  updatedAt: string | null;
}

export interface ParsedUrlList {
  urls: string[];
  /** Lines that could not be used, with why. Shown before anything runs. */
  problems: string[];
}

/**
 * Read the paste box: one URL per line, `#` starts a comment.
 *
 * Only tokenizes. Whether a URL is *permitted* — https, a uniben.edu host, not
 * a PDF, no docId collision — is validateManifest's decision, and asking it
 * twice in two places is how the two answers start disagreeing.
 */
export function parseUrlList(text: string): ParsedUrlList {
  const urls: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    if (seen.has(line)) {
      problems.push(`${line} — listed more than once`);
      continue;
    }
    seen.add(line);
    urls.push(line);
  }

  return { urls, problems };
}

/**
 * A readable citation label from a URL, used as the initial `source`.
 *
 * This text is shown to end users as the citation for anything retrieved from
 * the page, so it is offered as an editable starting point in the UI rather
 * than accepted silently. A machine-made label is a reasonable default and a
 * poor final answer.
 */
export function sourceLabelFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const host = parsed.hostname.replace(/^www\./, '');
  const segment = parsed.pathname.split('/').filter(Boolean).pop();
  if (!segment) return host;

  const title = segment
    .replace(/\.(x?html?|aspx?|php)$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');

  return title ? `${host} — ${title}` : host;
}

export function entriesFromUrls(
  urls: string[],
  classification: AdHocClassification,
): HarvestEntry[] {
  return urls.map((url) => ({
    url,
    source: sourceLabelFromUrl(url),
    namespace: classification.namespace,
    category: classification.category,
    roles: [...classification.roles],
    faculty: classification.faculty,
    contentType: classification.contentType,
    updatedAt: classification.updatedAt,
  }));
}
