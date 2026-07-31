// lib/harvest/manifest.ts
/**
 * The uniben.edu prose harvest manifest.
 *
 * This file is DATA, not a crawler. Every page the KB ingests from the web is
 * named here explicitly, with the access scope it will be stored under. There
 * is no link-following: a crawler that discovers pages decides on its own what
 * a student can read, and that decision belongs in review, in git, next to the
 * roles it grants.
 *
 * Scope split (see also: records vs prose). Prose — policies, requirements,
 * descriptions — belongs in the vector KB, which is what this manifest feeds.
 * Records — the list of faculties, departments, programmes, course codes —
 * belong in Supabase behind parameterized SQL, because vector search cannot
 * enumerate: "how many departments are there" has no reliable answer from
 * retrieved chunks. Course-listing pages appear here for their prose
 * (regulations, prerequisites), not as the source of truth for the catalogue.
 *
 * URLS ARE PROPOSALS. Every entry was taken from a search index, not fetched —
 * uniben.edu returns 403 to anything but the Cloudflare Worker proxy. Phase 1
 * of the runner (`/kb/fetch`, which costs no Unstructured quota) is what proves
 * a URL resolves and survives cleaning. Entries that fail phase 1 get removed
 * here; nothing is committed on the strength of this file alone.
 */

export const NAMESPACES = [
  'admissions',
  'academic-policy',
  'financial-aid',
  'programmes',
  'staff-internal',
  'general',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export const ROLES = ['prospective', 'student', 'parent', 'staff', 'hod'] as const;
export type Role = (typeof ROLES)[number];

export const CONTENT_TYPES = [
  'general', 'policy', 'handbook', 'faq', 'announcement', 'catalogue', 'markdown',
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export interface HarvestEntry {
  /** Page to fetch. Must be uniben.edu or a subdomain — core re-checks this. */
  url: string;
  /** Human label stored as the citation source. */
  source: string;
  namespace: Namespace;
  category: Namespace;
  /** Who may retrieve it. The whole point of reviewing this file. */
  roles: Role[];
  /** Faculty scope, or 'general' for institution-wide pages. */
  faculty: string;
  contentType: ContentType;
  /**
   * The page's own content date, or null when it genuinely shows none.
   *
   * Nearly every entry here is null, and that is a deliberate statement, not a
   * gap: these CMS pages display no publication or revision date anywhere.
   * Stamping today's date would mark them permanently fresh and turn the
   * staleness signal into a lie. Unknown age is not old age — retrieval says
   * "undated" rather than guessing in either direction.
   */
  updatedAt: string | null;
  programme?: string;
  levels?: string[];
  /** Why this page is in the harvest, when that is not obvious. */
  notes?: string;
}

/**
 * Stable document id derived from the URL.
 *
 * Derived rather than hand-assigned so two entries cannot collide, and so a
 * re-harvest of the same URL updates that document in place instead of
 * creating a duplicate under a new name.
 */
export function docIdFromUrl(url: string): string {
  const { hostname, pathname } = new URL(url);
  const host = hostname.replace(/^www\./, '').replace(/\.uniben\.edu$/, '').replace(/^uniben\.edu$/, 'main');
  const path = pathname
    .replace(/\.(x?html?|aspx?|php)$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase();
  return path ? `uniben-${host}-${path}` : `uniben-${host}-index`;
}

/** Filename handed to the extractor. Only affects display and logging. */
export function fileNameFromUrl(url: string): string {
  return `${docIdFromUrl(url)}.html`;
}

// ── Institution-wide ─────────────────────────────────────────────────────────
const INSTITUTION: HarvestEntry[] = [
  {
    url: 'https://uniben.edu/admissionrequirements.html',
    source: 'UNIBEN — Admission Requirements',
    namespace: 'admissions',
    category: 'admissions',
    // Prospective students are the primary audience; parents ask the same
    // questions on their behalf, and current students need it for change of
    // course and direct entry.
    roles: ['prospective', 'parent', 'student', 'staff', 'hod'],
    faculty: 'general',
    contentType: 'policy',
    updatedAt: null,
  },
  {
    url: 'https://uniben.edu/admission_policy.html',
    source: 'UNIBEN — Admission Policy',
    namespace: 'admissions',
    category: 'admissions',
    roles: ['prospective', 'parent', 'student', 'staff', 'hod'],
    faculty: 'general',
    contentType: 'policy',
    updatedAt: null,
  },
  {
    url: 'https://uniben.edu/policies.html',
    source: 'UNIBEN — University Policies',
    namespace: 'academic-policy',
    category: 'academic-policy',
    roles: ['student', 'staff', 'hod'],
    faculty: 'general',
    contentType: 'policy',
    updatedAt: null,
  },
  {
    url: 'https://uniben.edu/schoolsandfaculties.html',
    source: 'UNIBEN — Schools and Faculties',
    namespace: 'general',
    category: 'general',
    roles: ['prospective', 'parent', 'student', 'staff', 'hod'],
    faculty: 'general',
    contentType: 'general',
    updatedAt: null,
    notes:
      'Prose only. The authoritative faculty/department list is a RECORD and belongs ' +
      'in Supabase — vector search cannot answer "how many faculties are there".',
  },
  {
    url: 'https://studentaffairs.uniben.edu/',
    source: 'UNIBEN Student Affairs Division',
    namespace: 'general',
    category: 'general',
    roles: ['student', 'parent', 'staff', 'hod'],
    faculty: 'general',
    contentType: 'general',
    updatedAt: null,
  },
  {
    url: 'https://studentaffairs.uniben.edu/index.php/policies/',
    source: 'UNIBEN Student Affairs — Policies',
    namespace: 'academic-policy',
    category: 'academic-policy',
    roles: ['student', 'parent', 'staff', 'hod'],
    faculty: 'general',
    contentType: 'policy',
    updatedAt: null,
  },
];

// ── Faculty of Physical Sciences — the pilot ─────────────────────────────────
// Chosen over Computing deliberately: physci has the page depth to actually
// exercise the pipeline. Computing is new and thin, so a clean run there would
// prove little about a full faculty.
const PHYSICAL_SCIENCES: HarvestEntry[] = [
  {
    url: 'https://physci.uniben.edu/',
    source: 'Faculty of Physical Sciences — Overview',
    namespace: 'general',
    category: 'general',
    roles: ['prospective', 'parent', 'student', 'staff', 'hod'],
    faculty: 'physical-sciences',
    contentType: 'general',
    updatedAt: null,
  },
  {
    url: 'https://physci.uniben.edu/history/',
    source: 'Faculty of Physical Sciences — History',
    namespace: 'general',
    category: 'general',
    roles: ['prospective', 'parent', 'student', 'staff', 'hod'],
    faculty: 'physical-sciences',
    contentType: 'general',
    updatedAt: null,
  },
  {
    url: 'https://physci.uniben.edu/departments/',
    source: 'Faculty of Physical Sciences — Departments',
    namespace: 'programmes',
    category: 'programmes',
    roles: ['prospective', 'parent', 'student', 'staff', 'hod'],
    faculty: 'physical-sciences',
    contentType: 'general',
    updatedAt: null,
  },
  {
    url: 'https://physci.uniben.edu/academics-departments/',
    source: 'Faculty of Physical Sciences — Academic Departments',
    namespace: 'programmes',
    category: 'programmes',
    roles: ['prospective', 'parent', 'student', 'staff', 'hod'],
    faculty: 'physical-sciences',
    contentType: 'general',
    updatedAt: null,
  },
  {
    url: 'https://physci.uniben.edu/general-regulations-and-degree-requirements-for-undergraduates-under-the-course-credit-system/',
    source: 'Faculty of Physical Sciences — General Regulations and Degree Requirements',
    namespace: 'academic-policy',
    category: 'academic-policy',
    roles: ['prospective', 'parent', 'student', 'staff', 'hod'],
    faculty: 'physical-sciences',
    contentType: 'policy',
    updatedAt: null,
    notes: 'Highest-value page in the pilot — credit system, degree requirements, progression.',
  },
  {
    url: 'https://physci.uniben.edu/general-regulations-and-part-time-degree-requirements-for-undergraduates-under-the-course-credit-system/',
    source: 'Faculty of Physical Sciences — Part-Time Degree Programmes',
    namespace: 'academic-policy',
    category: 'academic-policy',
    roles: ['prospective', 'parent', 'student', 'staff', 'hod'],
    faculty: 'physical-sciences',
    contentType: 'policy',
    updatedAt: null,
  },
  {
    url: 'https://physci.uniben.edu/courses/',
    source: 'Faculty of Physical Sciences — Courses',
    namespace: 'programmes',
    category: 'programmes',
    roles: ['prospective', 'parent', 'student', 'staff', 'hod'],
    faculty: 'physical-sciences',
    contentType: 'catalogue',
    updatedAt: null,
    notes: 'Ingested for course descriptions and prerequisites, not as the course catalogue of record.',
  },
  {
    url: 'https://physci.uniben.edu/contact/',
    source: 'Faculty of Physical Sciences — Contact',
    namespace: 'general',
    category: 'general',
    roles: ['prospective', 'parent', 'student', 'staff', 'hod'],
    faculty: 'physical-sciences',
    contentType: 'general',
    updatedAt: null,
  },
];

// Department pages, one pair per department (overview + courses) where both exist.
const PHYSCI_DEPARTMENTS: HarvestEntry[] = (
  [
    ['department-of-computer-science',        'Computer Science'],
    ['department-of-computer-science-courses','Computer Science — Courses'],
    ['department-of-computer-science-part-time','Computer Science — Part Time'],
    ['department-of-chemistry',               'Chemistry'],
    ['department-of-chemistry-courses',       'Chemistry — Courses'],
    ['department-of-geology-courses',         'Geology — Courses'],
    ['department-of-statistics',              'Statistics'],
    ['department-of-statistics-courses',      'Statistics — Courses'],
    ['department-of-mathematics-courses',     'Mathematics — Courses'],
    ['department-of-physics-courses',         'Physics — Courses'],
    ['department-of-physics-part-time',       'Physics — Part Time'],
    ['industrial-mathematics-courses',        'Industrial Mathematics — Courses'],
  ] as const
).map(([slug, label]): HarvestEntry => ({
  url: `https://physci.uniben.edu/${slug}/`,
  source: `Faculty of Physical Sciences — ${label}`,
  namespace: 'programmes',
  category: 'programmes',
  roles: ['prospective', 'parent', 'student', 'staff', 'hod'],
  faculty: 'physical-sciences',
  contentType: label.includes('Courses') ? 'catalogue' : 'general',
  updatedAt: null,
}));

// ── Faculty of Computing ─────────────────────────────────────────────────────
/**
 * Computing is a real faculty in the student records system
 * (waeup.uniben.edu/faculties/CIS) but has NO public faculty website — its
 * department pages still sit under physci.uniben.edu, which has not caught up
 * with the reorganisation.
 *
 * So there is no prose to harvest for it, and this array is empty by finding
 * rather than by omission. Computing is covered two other ways: the Computer
 * Science pages above (same programmes, filed under physical-sciences until the
 * site moves them), and hand-entered records in Supabase. Deleting this block
 * would lose that explanation, which is why it stays.
 */
const COMPUTING: HarvestEntry[] = [];

export const MANIFEST: HarvestEntry[] = [
  ...INSTITUTION,
  ...PHYSICAL_SCIENCES,
  ...PHYSCI_DEPARTMENTS,
  ...COMPUTING,
];

// ── Validation ───────────────────────────────────────────────────────────────

export interface ManifestProblem {
  url: string;
  problem: string;
}

const UNIBEN_HOST = /(^|\.)uniben\.edu$/i;

/**
 * Check the manifest before a single request is made.
 *
 * Catches the mistakes that are expensive to discover later: a duplicate docId
 * silently overwriting another page's vectors, a role typo that widens access,
 * a PDF on a path that cannot handle one.
 */
export function validateManifest(entries: HarvestEntry[] = MANIFEST): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const seenDocIds = new Map<string, string>();
  const seenUrls = new Set<string>();

  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL(entry.url);
    } catch {
      problems.push({ url: entry.url, problem: 'not a valid URL' });
      continue;
    }

    if (parsed.protocol !== 'https:') {
      problems.push({ url: entry.url, problem: `must be https, got ${parsed.protocol}` });
    }
    if (!UNIBEN_HOST.test(parsed.hostname)) {
      problems.push({ url: entry.url, problem: `host ${parsed.hostname} is not uniben.edu` });
    }

    // A PDF reaches ingestion as `sourceUrl`, where core does
    // `new TextEncoder().encode(page.html)` — that mangles binary. PDFs must be
    // uploaded as fileBufferBase64 instead. Failing here beats ingesting noise.
    if (/\.pdf$/i.test(parsed.pathname)) {
      problems.push({
        url: entry.url,
        problem: 'PDFs cannot be harvested by URL — the sourceUrl path treats the body as text. Upload it as a file instead.',
      });
    }

    if (seenUrls.has(entry.url)) {
      problems.push({ url: entry.url, problem: 'duplicate URL' });
    }
    seenUrls.add(entry.url);

    const docId = docIdFromUrl(entry.url);
    const collision = seenDocIds.get(docId);
    if (collision && collision !== entry.url) {
      problems.push({
        url: entry.url,
        problem: `docId "${docId}" collides with ${collision} — one would overwrite the other`,
      });
    }
    seenDocIds.set(docId, entry.url);

    if (!NAMESPACES.includes(entry.namespace)) {
      problems.push({ url: entry.url, problem: `unknown namespace "${entry.namespace}"` });
    }
    if (!NAMESPACES.includes(entry.category)) {
      problems.push({ url: entry.url, problem: `unknown category "${entry.category}"` });
    }
    if (!CONTENT_TYPES.includes(entry.contentType)) {
      problems.push({ url: entry.url, problem: `unknown contentType "${entry.contentType}"` });
    }
    if (entry.roles.length === 0) {
      problems.push({ url: entry.url, problem: 'no roles — the document would be unreachable' });
    }
    for (const role of entry.roles) {
      if (!ROLES.includes(role)) {
        problems.push({ url: entry.url, problem: `unknown role "${role}"` });
      }
    }
    if (entry.updatedAt !== null && Number.isNaN(Date.parse(entry.updatedAt))) {
      problems.push({ url: entry.url, problem: `updatedAt "${entry.updatedAt}" is not a date` });
    }
    if (!entry.source.trim()) {
      problems.push({ url: entry.url, problem: 'empty source label — citations would be blank' });
    }
  }

  return problems;
}

/** The request body core expects for one entry. */
export function toIngestBody(entry: HarvestEntry, dryRun: boolean): Record<string, unknown> {
  return {
    docId: docIdFromUrl(entry.url),
    fileName: fileNameFromUrl(entry.url),
    category: entry.category,
    namespace: entry.namespace,
    faculty: entry.faculty,
    source: entry.source,
    roles: entry.roles,
    // Explicit null, never omitted: core rejects an absent updatedAt precisely
    // so that "undated" is always a decision someone made.
    updatedAt: entry.updatedAt,
    contentType: entry.contentType,
    sourceUrl: entry.url,
    ...(entry.programme ? { programme: entry.programme } : {}),
    ...(entry.levels?.length ? { levels: entry.levels } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  };
}
