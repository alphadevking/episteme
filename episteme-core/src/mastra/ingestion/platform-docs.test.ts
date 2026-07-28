// episteme-core/src/mastra/ingestion/platform-docs.test.ts
/**
 * Tests for the platform documentation corpus rules.
 *
 * These run with no credentials and no network — the module under test imports
 * neither Pinecone nor the database, which is the whole point: the CI guard has
 * to be runnable, or it will be turned off.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlatformDoc,
  parseFrontmatter,
  assertUniqueDocIds,
  splitIntoSections,
  rankSections,
  tokenize,
  loadPlatformDocs,
  DIRECTORY_NAMESPACE,
  type PlatformDoc,
} from './platform-docs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_ROOT = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'content', 'platform',
);

function doc(overrides: Partial<Record<string, string>> = {}, body = '# Body\n\nText.\n'): string {
  const fm = {
    docId: 'platform-admin-test',
    title: 'Test',
    namespace: 'platform-admin',
    roles: '[staff, hod]',
    updated: '2026-07-28',
    ...overrides,
  };
  const lines = Object.entries(fm)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

describe('parseFrontmatter', () => {
  test('splits frontmatter from body', () => {
    const { data, body } = parseFrontmatter('---\na: 1\n---\nhello\n', 'x.md');
    assert.equal(data['a'], '1');
    assert.equal(body, 'hello\n');
  });

  test('parses inline lists and strips quotes', () => {
    const { data } = parseFrontmatter('---\nroles: [staff, "hod"]\nt: \'q\'\n---\nb', 'x.md');
    assert.deepEqual(data['roles'], ['staff', 'hod']);
    assert.equal(data['t'], 'q');
  });

  test('tolerates CRLF line endings', () => {
    const { data, body } = parseFrontmatter('---\r\na: 1\r\n---\r\nhello', 'x.md');
    assert.equal(data['a'], '1');
    assert.equal(body, 'hello');
  });

  test('throws when the frontmatter block is missing', () => {
    assert.throws(() => parseFrontmatter('# no frontmatter', 'x.md'), /missing frontmatter/);
  });
});

describe('parsePlatformDoc — the directory is authoritative', () => {
  test('a namespace disagreeing with its directory is rejected', () => {
    // The failure that matters: a typo publishing an operator runbook into the
    // namespace every user can read.
    assert.throws(
      () => parsePlatformDoc(doc({ namespace: 'platform-help' }), 'admin', 'x.md'),
      /does not match directory/,
    );
  });

  test('an unknown directory is rejected', () => {
    assert.throws(() => parsePlatformDoc(doc(), 'secret', 'x.md'), /unknown content directory/);
  });

  test('matching namespace and directory parses', () => {
    const parsed = parsePlatformDoc(doc(), 'admin', 'x.md');
    assert.equal(parsed.namespace, DIRECTORY_NAMESPACE['admin']);
    assert.equal(parsed.relPath, 'admin/x.md');
  });
});

describe('parsePlatformDoc — validation fails closed', () => {
  test('every required field is required', () => {
    for (const key of ['docId', 'title', 'namespace', 'updated']) {
      assert.throws(
        () => parsePlatformDoc(doc({ [key]: undefined }), 'admin', 'x.md'),
        new RegExp(key === 'namespace' ? 'namespace' : `"${key}" is required`),
        `missing ${key} was accepted`,
      );
    }
  });

  test('roles must be a non-empty list of real retrieval roles', () => {
    assert.throws(() => parsePlatformDoc(doc({ roles: '[]' }), 'admin', 'x.md'), /non-empty list/);
    assert.throws(() => parsePlatformDoc(doc({ roles: 'staff' }), 'admin', 'x.md'), /non-empty list/);
    assert.throws(
      () => parsePlatformDoc(doc({ roles: '[staff, admin]' }), 'admin', 'x.md'),
      /invalid roles: admin/,
    );
  });

  test('an unparseable or future date is rejected', () => {
    assert.throws(() => parsePlatformDoc(doc({ updated: 'soon' }), 'admin', 'x.md'), /not a valid date/);
    assert.throws(
      () => parsePlatformDoc(doc({ updated: '2030-01-01' }), 'admin', 'x.md'),
      /in the future/,
    );
  });

  test('an empty body is rejected', () => {
    assert.throws(() => parsePlatformDoc(doc({}, '   \n'), 'admin', 'x.md'), /body is empty/);
  });
});

describe('splitIntoSections', () => {
  const build = (body: string): PlatformDoc =>
    parsePlatformDoc(doc({}, body), 'admin', 'x.md');

  test('splits on ## headings and keeps the heading in the text', () => {
    const sections = splitIntoSections(build('# Title\n\nIntro.\n\n## One\n\nA.\n\n## Two\n\nB.\n'));
    assert.deepEqual(sections.map((s) => s.heading), ['Test', 'One', 'Two']);
    assert.ok(sections[1].text.startsWith('One'));
    assert.ok(sections[1].text.includes('A.'));
  });

  test('content before the first ## becomes an intro under the doc title', () => {
    const sections = splitIntoSections(build('# Title\n\nIntro prose.\n\n## One\n\nA.\n'));
    assert.equal(sections[0].heading, 'Test');
    assert.ok(sections[0].text.includes('Intro prose.'));
  });

  test('the `# Title` line is dropped, not indexed as content', () => {
    const sections = splitIntoSections(build('# Title\n\nIntro.\n'));
    assert.ok(!sections[0].text.includes('# Title'));
  });

  test('a ## inside a fenced code block is not a heading', () => {
    // Splitting there would tear the code block in half.
    const sections = splitIntoSections(
      build('# T\n\nIntro.\n\n## Real\n\n```bash\n## not a heading\necho hi\n```\n'),
    );
    assert.deepEqual(sections.map((s) => s.heading), ['Test', 'Real']);
    assert.ok(sections[1].text.includes('## not a heading'));
  });

  test('a heading with no prose under it is not retrievable', () => {
    const sections = splitIntoSections(build('# T\n\nIntro.\n\n## Empty\n\n## Full\n\nText.\n'));
    assert.deepEqual(sections.map((s) => s.heading), ['Test', 'Full']);
  });

  test('sections carry the parent document\'s namespace and roles', () => {
    for (const s of splitIntoSections(build('# T\n\nIntro.\n\n## One\n\nA.\n'))) {
      assert.equal(s.namespace, DIRECTORY_NAMESPACE['admin']);
      assert.deepEqual(s.roles, ['staff', 'hod']);
      assert.equal(s.docId, 'platform-admin-test');
    }
  });
});

describe('tokenize', () => {
  test('drops short tokens, punctuation and stopwords', () => {
    assert.deepEqual(tokenize('How do I set up the system?'), []);
    assert.deepEqual(tokenize('onboard new staff members'), ['onboard', 'new', 'staff', 'members']);
  });

  test('is case- and punctuation-insensitive', () => {
    assert.deepEqual(tokenize('Access-Levels, ROLES.'), tokenize('access levels roles'));
  });
});

describe('assertUniqueDocIds', () => {
  test('rejects two files sharing a docId', () => {
    const docs = [
      { docId: 'a', relPath: 'help/one.md' },
      { docId: 'a', relPath: 'admin/two.md' },
    ] as PlatformDoc[];
    assert.throws(() => assertUniqueDocIds(docs), /duplicate docId "a"/);
  });
});

describe('rankSections', () => {
  const section = (heading: string, text: string, namespace = 'platform-admin') => ({
    docId: heading, title: heading, heading, text: `${heading}\n\n${text}`,
    namespace, roles: ['staff'], relPath: `admin/${heading}.md`,
  });

  const corpus = [
    section('Onboarding users and setting access levels',
      'Invite a staff member, choose their role, and their trust level is set automatically.'),
    section('Adding documents to the knowledge base',
      'Upload a file or paste Markdown. Choose the namespace and the content date.'),
    section('Setting up your institution',
      'Create the institution record first, then faculties, departments and programmes.'),
  ];

  test('ranks the section a question is actually about first', () => {
    const ranked = rankSections(corpus, 'How do I onboard new staff and set their access levels?', 0.5);
    assert.ok(ranked.length > 0, 'no section matched');
    assert.equal(ranked[0].section.heading, 'Onboarding users and setting access levels');
  });

  test('routes a different question to a different section', () => {
    const ranked = rankSections(corpus, 'How do I upload a document to the knowledge base?', 0.5);
    assert.equal(ranked[0].section.heading, 'Adding documents to the knowledge base');
  });

  test('abstains rather than returning the least-bad match', () => {
    // The property that matters most: an unrelated question must yield nothing,
    // so the cascade falls through to the institutional tiers.
    assert.deepEqual(rankSections(corpus, 'What are the school fees for 200 level Engineering?', 0.5), []);
    assert.deepEqual(rankSections(corpus, 'Who is the current Vice Chancellor?', 0.5), []);
    assert.deepEqual(rankSections(corpus, 'How do I calculate my CGPA?', 0.5), []);
  });

  test('a query of only stopwords matches nothing rather than everything', () => {
    // The inverse of the news tool, where a bare "latest news" should return the
    // feed. Here an empty query must never surface documentation at random.
    assert.deepEqual(rankSections(corpus, 'how do I use the', 0.5), []);
    assert.deepEqual(rankSections(corpus, '', 0.5), []);
  });

  test('stemming bridges onboard/onboarding and level/levels', () => {
    const ranked = rankSections(corpus, 'staff onboarding access level', 0.5);
    assert.equal(ranked[0].section.heading, 'Onboarding users and setting access levels');
  });

  test('coverage is bounded 0–1 and gates the result', () => {
    for (const r of rankSections(corpus, 'onboard staff access levels', 0)) {
      assert.ok(r.coverage >= 0 && r.coverage <= 1, `coverage out of range: ${r.coverage}`);
    }
    const strict = rankSections(corpus, 'onboard staff access levels', 1);
    for (const r of strict) assert.equal(r.coverage, 1);
  });

  test('raising minCoverage never adds a result', () => {
    const q = 'namespace content date document';
    const loose = rankSections(corpus, q, 0.25).map((r) => r.section.heading);
    const tight = rankSections(corpus, q, 0.75).map((r) => r.section.heading);
    for (const h of tight) assert.ok(loose.includes(h), `"${h}" appeared only at the tighter gate`);
  });

  test('an empty corpus yields nothing rather than throwing', () => {
    assert.deepEqual(rankSections([], 'anything at all', 0.5), []);
  });

  test('an incidental mention does not make a section "about" that topic', () => {
    // The false positive that heading-anchoring exists to stop. This section
    // explains a PLATFORM concept using a university example, so it mentions
    // fees, levels and students without being about any of them.
    const withExample = [section('Fields you set, and what each one does',
      'A fees document placed in General is readable by every visitor. ' +
      'Programme and level are optional narrowing for students.')];

    assert.deepEqual(
      rankSections(withExample, 'What are the school fees for 200 level Engineering students?', 0.5),
      [],
      'an institutional question was captured by an incidental mention',
    );
  });

  test('heading-anchoring does not block a query that matches the prose strongly', () => {
    // The other side of the trade: coverage at or above strongCoverage still
    // qualifies without a heading match, so a well-aimed question about body
    // prose is not lost.
    const s = [section('Replacing and removing',
      'Re-ingesting a document replaces its previous version completely.')];
    const ranked = rankSections(s, 'ingesting a document previous version', 0.5);
    assert.equal(ranked.length, 1, 'a strongly-covered body match was dropped');
    assert.equal(ranked[0].headingMatches, 0, 'expected a body-only match');
  });

  test('headingMatches is reported and is zero for body-only matches', () => {
    const s = [section('Account status', 'Suspending an account blocks it at sign-in.')];
    assert.ok(rankSections(s, 'account status', 0.5)[0].headingMatches > 0);
    assert.equal(rankSections(s, 'suspending sign-in blocks', 0.5)[0]?.headingMatches, 0);
  });
});

describe('the committed corpus', () => {
  test('every shipped document parses and validates', async () => {
    // Catches a malformed doc at test time rather than at deploy time.
    const docs = await loadPlatformDocs(CONTENT_ROOT);
    assert.ok(docs.length > 0, 'no platform documents found');
  });

  test('both platform namespaces have at least one document', async () => {
    // An empty namespace is not neutral: every question it should answer
    // abstains, which reads to the user as the system being broken.
    const docs = await loadPlatformDocs(CONTENT_ROOT);
    for (const namespace of Object.values(DIRECTORY_NAMESPACE)) {
      assert.ok(
        docs.some((d) => d.namespace === namespace),
        `namespace "${namespace}" has no documents`,
      );
    }
  });

  test('admin documents are never tagged for non-staff roles', async () => {
    // Defence in depth behind the trust-4 + platform-admin gate: an operator
    // runbook tagged [student] would still be gated, but the tag is wrong and a
    // future change to the gate should not be the only thing standing in the way.
    const docs = await loadPlatformDocs(CONTENT_ROOT);
    for (const d of docs.filter((x) => x.namespace === DIRECTORY_NAMESPACE['admin'])) {
      for (const role of d.roles) {
        assert.ok(['staff', 'hod'].includes(role), `${d.relPath} tagged for "${role}"`);
      }
    }
  });
});
