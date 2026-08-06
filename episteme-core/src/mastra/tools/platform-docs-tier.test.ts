// episteme-core/src/mastra/tools/platform-docs-tier.test.ts
/**
 * End-to-end tests for the platform tier against the REAL shipped corpus.
 *
 * These run with no credentials and no network — the whole point of serving
 * this corpus from disk. They assert three things the unit tests cannot:
 * that the access gate is applied before ranking, that the shipped documents
 * actually answer the questions they exist to answer, and that institutional
 * questions fall through instead of being captured.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { searchPlatformDocs, loadPlatformSections } from './platform-docs-tier';
import { resolvePlatformNamespaces } from '../security/retrieval-gate';

const ADMIN_NS  = resolvePlatformNamespaces({ trustLevel: 4, isPlatformAdmin: true });
const PUBLIC_NS = resolvePlatformNamespaces({ trustLevel: 1 });

describe('the shipped corpus loads', () => {
  test('sections are produced from the real files', async () => {
    const sections = await loadPlatformSections();
    assert.ok(sections.length > 0, 'no sections loaded');
    for (const s of sections) {
      assert.ok(s.text.trim().length > 0, `${s.relPath}: empty section`);
      assert.ok(s.heading.trim().length > 0, `${s.relPath}: empty heading`);
    }
  });
});

describe('the question that started this', () => {
  test('an admin asking about onboarding and access levels gets an answer', async () => {
    // The exact query that abstained and was reinterpreted as a university HR
    // question. It must now resolve from the platform corpus.
    const hit = await searchPlatformDocs(
      'How do I onboard new staff members and set their access levels?',
      ADMIN_NS,
    );
    assert.ok(hit, 'no platform documentation matched');
    assert.match(hit.context, /trust level/i);
    assert.ok(hit.sources.length > 0, 'no sources returned');
  });

  test('the answer is about Episteme roles, not university HR', async () => {
    const hit = await searchPlatformDocs(
      'How do I onboard new staff members and set their access levels?',
      ADMIN_NS,
    );
    assert.ok(hit);
    // The failure mode from the screenshot: refinements offering "the general
    // HR or administrative onboarding policy".
    assert.doesNotMatch(hit.context, /human resources|HR policy/i);
  });
});

describe('the access gate is applied before ranking', () => {
  test('a public caller never receives platform-admin content', async () => {
    for (const query of [
      'How do I onboard new staff members and set their access levels?',
      'How do I set up a new institution?',
      'How do I add documents to the knowledge base?',
    ]) {
      const hit = await searchPlatformDocs(query, PUBLIC_NS);
      if (!hit) continue;
      // A help-tier match is fine; admin prose is not.
      assert.doesNotMatch(hit.context, /Invite a staff member|institution record first/i,
        `admin content leaked to a public caller for: ${query}`);
    }
  });

  test('trust 4 without the platform-admin bit is denied the runbook', async () => {
    // A lecturer at trust 4 is privileged in their institution but does not
    // operate the platform.
    const staffNs = resolvePlatformNamespaces({ trustLevel: 4, isPlatformAdmin: false });
    const hit = await searchPlatformDocs('How do I set up a new institution?', staffNs);
    if (hit) assert.doesNotMatch(hit.context, /institution record first/i);
  });

  test('an empty namespace list returns nothing', async () => {
    assert.equal(await searchPlatformDocs('How do I onboard staff?', []), null);
  });

  test('the platform-admin bit at trust 3 grants nothing extra', async () => {
    const ns = resolvePlatformNamespaces({ trustLevel: 3, isPlatformAdmin: true });
    const hit = await searchPlatformDocs('How do I set up a new institution?', ns);
    if (hit) assert.doesNotMatch(hit.context, /institution record first/i);
  });
});

describe('institutional questions fall through', () => {
  test('university questions do not match the platform corpus', async () => {
    // If this tier captured these, the cascade would never reach the KB and
    // every institutional question would break.
    for (const query of [
      'How do I calculate my CGPA?',
      'What are the school fees for 200 level Engineering students?',
      'Who is the current Vice Chancellor?',
      'When does registration close?',
      'What are the admission requirements for Computer Science?',
      'Where is the bursary office?',
    ]) {
      assert.equal(await searchPlatformDocs(query, ADMIN_NS), null, `captured: ${query}`);
    }
  });
});

describe('help tier is public', () => {
  test('a prospective visitor can ask how the assistant works', async () => {
    const hit = await searchPlatformDocs('What can this assistant answer for me?', PUBLIC_NS);
    assert.ok(hit, 'platform-help was not reachable at trust 1');
  });
});

describe('output shape matches the KB tier', () => {
  test('sources are numbered from 1 with no gaps, one per document', async () => {
    const hit = await searchPlatformDocs(
      'How do I onboard new staff members and set their access levels?',
      ADMIN_NS,
    );
    assert.ok(hit);
    assert.deepEqual(
      hit.sources.map((s) => s.number),
      hit.sources.map((_, i) => i + 1),
    );
    assert.equal(new Set(hit.sources.map((s) => s.title)).size, hit.sources.length);
  });

  test('every cited source number appears in the context', async () => {
    // A citation the model can emit but that has no matching chunk renders as
    // nothing, silently erasing the claim's evidence.
    const hit = await searchPlatformDocs('How do I add documents to the knowledge base?', ADMIN_NS);
    assert.ok(hit);
    for (const s of hit.sources) {
      assert.ok(hit.context.includes(`[Source ${s.number}]`), `Source ${s.number} not in context`);
    }
  });

  test('the context tells the model not to add staleness or office caveats', async () => {
    // The defect that motivated moving off the KB path: product documentation
    // must never be described as outdated or referred to a university office.
    const hit = await searchPlatformDocs('How do I onboard new staff members?', ADMIN_NS);
    assert.ok(hit);
    assert.match(hit.context, /not institutional policy/i);
    assert.doesNotMatch(hit.context, /may be outdated/i);
  });
});

describe('product-identity questions', () => {
  /**
   * REGRESSION. "What can this assistant do" tokenizes to nothing — every word
   * is grammar or a product name, all removed as non-discriminating — so
   * rankSections early-returned and the one question every role can ask went
   * unanswered. Its verbose paraphrase worked, which is why the suggestion chip
   * passed while the typed question failed.
   */
  for (const query of [
    'what can this assistant do',
    'what is episteme',
    'what can you do',
    'what is this platform',
  ]) {
    test(`"${query}" is answered from the help document`, async () => {
      const hit = await searchPlatformDocs(query, PUBLIC_NS);
      assert.ok(hit, `"${query}" abstained — the identity fallback did not fire`);
      assert.ok(
        hit.sources.some((s) => /getting started/i.test(s.title)),
        `answered from ${hit.sources.map((s) => s.title).join(', ')} instead of the help doc`,
      );
    });
  }

  test('an operator gets the introduction, not the admin runbooks', async () => {
    // The fallback is restricted to the help namespace. Without that, an
    // operator asking what the product does would be handed the ingestion
    // procedure — the identity query's terms match those pages too.
    const hit = await searchPlatformDocs('what can this assistant do', ADMIN_NS);
    assert.ok(hit);
    assert.deepEqual(
      hit.sources.map((s) => s.title),
      ['Getting started with Episteme'],
    );
  });

  test('the fallback never widens what a caller may see', async () => {
    // It filters `visible`, which is already access-filtered, so it can only
    // ever remove. A caller with no namespaces still gets nothing.
    assert.equal(await searchPlatformDocs('what can this assistant do', []), null);
  });

  test('an empty query is a caller bug, not an identity question', async () => {
    // "" also tokenizes to nothing. Answering it with documentation would hide
    // the bug behind a plausible-looking response.
    assert.equal(await searchPlatformDocs('', PUBLIC_NS), null);
    assert.equal(await searchPlatformDocs('   ', PUBLIC_NS), null);
  });

  test('queries that DO carry content terms are unaffected', async () => {
    // The fallback must not become a catch-all. These have real terms, so they
    // take the ordinary ranking path and must still abstain.
    for (const query of [
      'how do I bake sourdough bread at home',
      'what are the school fees for 200 level students',
    ]) {
      assert.equal(await searchPlatformDocs(query, PUBLIC_NS), null, `"${query}" was captured`);
    }
  });
});
