import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPageHtml, assertIngestableUrl, fileNameFromUrl } from './url-fetcher';

// ── cleanPageHtml ────────────────────────────────────────────────────────────
// Modeled on the real principal-staff page: officer cards separated by a
// repeated "Teachers" category badge, plus nav/footer/script furniture. The
// regression: that junk landed in the KB and diluted the name→title pairs.

const STAFF_PAGE = `
<html><head><script>var x=1;</script><style>.a{}</style></head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<h1>Principal Staff</h1>
<div class="card"><a href="/staff/1">PROF. EDOBA BRIGHT OMOREGIE, SAN</a><p>Vice Chancellor</p><a href="/cat/teachers">Teachers</a></div>
<div class="card"><a href="/staff/2">PROF. CHRISTOPHER OSUBOR</a><p>Deputy Vice Chancellor Administration</p><a href="/cat/teachers">Teachers</a></div>
<div class="card"><a href="/staff/3">MR. ADEMOLA BOBOLA</a><p>Registrar</p><a href="/cat/teachers">Teachers</a></div>
<footer><a href="/privacy">Privacy</a> © University of Benin</footer>
</body></html>`;

test('cleanPageHtml drops script/style/nav/footer wholesale', () => {
  const out = cleanPageHtml(STAFF_PAGE);
  assert.ok(!out.includes('var x=1'), 'script content removed');
  assert.ok(!out.includes('.a{}'), 'style content removed');
  assert.ok(!out.includes('/about'), 'nav removed');
  assert.ok(!out.includes('Privacy'), 'footer removed');
});

test('cleanPageHtml removes repeated badge anchors but keeps unique name anchors', () => {
  const out = cleanPageHtml(STAFF_PAGE);
  assert.ok(!out.includes('>Teachers<'), 'repeated "Teachers" badge (3×) removed');
  assert.ok(out.includes('PROF. EDOBA BRIGHT OMOREGIE, SAN'), 'unique officer name survives');
  assert.ok(out.includes('MR. ADEMOLA BOBOLA'), 'unique officer name survives');
  assert.ok(out.includes('Vice Chancellor'), 'titles survive');
});

test('cleanPageHtml keeps a label that appears only twice', () => {
  const twice = '<p><a href="/a">Apply Now</a> text <a href="/b">Apply Now</a></p>';
  assert.ok(cleanPageHtml(twice).includes('Apply Now'), 'below the 3× threshold — kept');
});

// ── assertIngestableUrl — the SSRF allowlist guard ───────────────────────────

test('accepts uniben.edu apex and subdomains', () => {
  assert.ok(assertIngestableUrl('https://uniben.edu/principal-staff.html'));
  assert.ok(assertIngestableUrl('https://www.uniben.edu/admission_policy.html'));
  assert.ok(assertIngestableUrl('https://news.uniben.edu/feed/'));
});

test('rejects look-alike and foreign hosts', () => {
  for (const bad of [
    'https://evil-uniben.edu/x',
    'https://uniben.edu.evil.com/x',
    'https://example.com/uniben.edu',
    'https://google.com/',
  ]) {
    assert.throws(() => assertIngestableUrl(bad), /Only uniben\.edu/, `must reject ${bad}`);
  }
});

test('rejects non-http(s) schemes and garbage', () => {
  assert.throws(() => assertIngestableUrl('ftp://uniben.edu/x'), /http/);
  assert.throws(() => assertIngestableUrl('not a url'), /Not a valid URL/);
});

// ── fileNameFromUrl ──────────────────────────────────────────────────────────

test('derives .html names from page URLs', () => {
  assert.equal(fileNameFromUrl('https://uniben.edu/principal-staff.html'), 'principal-staff.html');
  assert.equal(fileNameFromUrl('https://www.uniben.edu/'), 'uniben.edu.html');
});
