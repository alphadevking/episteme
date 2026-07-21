import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeNewsQuery, scoreNewsItem, rankNewsItems } from './uniben-news-tool';

// These posts are the actual off-topic ones the live feed returned for a JAMB
// query (see grounded-cascade-relevance-root-cause). The regression guard: a
// relevance floor must reject them so the news fallback returns nothing and the
// cascade falls back to the relevant KB answer instead of abstaining.
const OFF_TOPIC = [
  { title: 'UNIBEN VC MOVES TO STRENGTHEN SYNERGY WITH NATIONAL INSTITUTE FOR SPORTS', summary: 'The Vice Chancellor visited the institute to discuss collaboration for sports development.' },
  { title: 'UNIBEN SOIL SCIENTISTS DELIVER GROUND-BREAKING SOIL FERTILITY AND LAND RESEARCH', summary: 'Researchers presented findings on soil fertility across the region.' },
];
const ON_TOPIC = {
  title: 'UNIBEN Announces JAMB UTME Admission Requirements for 2026',
  summary: 'Candidates must score a minimum UTME mark to be considered for admission.',
};

const JAMB_QUERY = 'minimum JAMB UTME score required for admission into UNIBEN';

test('tokenizeNewsQuery drops the institution name and function words', () => {
  const tokens = tokenizeNewsQuery(JAMB_QUERY);
  assert.ok(!tokens.includes('uniben'), 'institution name must not be a topical token');
  assert.ok(!tokens.includes('for') && !tokens.includes('into'), 'function words excluded');
  for (const t of ['minimum', 'jamb', 'utme', 'score', 'required', 'admission']) {
    assert.ok(tokens.includes(t), `expected topical token: ${t}`);
  }
});

test('off-topic posts score below the 0.34 fallback floor for a JAMB query', () => {
  const tokens = tokenizeNewsQuery(JAMB_QUERY);
  for (const post of OFF_TOPIC) {
    assert.ok(scoreNewsItem(post, tokens) < 0.34, `off-topic post should score low: ${post.title}`);
  }
});

test('an on-topic post clears the floor', () => {
  const tokens = tokenizeNewsQuery(JAMB_QUERY);
  assert.ok(scoreNewsItem(ON_TOPIC, tokens) >= 0.34, 'on-topic post should clear the floor');
});

test('rankNewsItems with the fallback floor rejects the exact off-topic feed', () => {
  // The precise regression: the feed the cascade saw contained ONLY off-topic
  // posts. With the floor, rankNewsItems returns nothing → news fallback null.
  const ranked = rankNewsItems(OFF_TOPIC, JAMB_QUERY, 0.34, 10);
  assert.equal(ranked.length, 0, 'off-topic-only feed must yield zero results under the floor');
});

test('rankNewsItems surfaces the on-topic post ahead of off-topic ones', () => {
  const feed = [...OFF_TOPIC, ON_TOPIC];
  const ranked = rankNewsItems(feed, JAMB_QUERY, 0.34, 10);
  assert.equal(ranked.length, 1, 'only the on-topic post clears the floor');
  assert.equal(ranked[0].title, ON_TOPIC.title);
});

test('minScore=0 (explicit news tool) preserves the feed — "latest news" still works', () => {
  // A stopword-only query has no topical tokens → every post scores 1.
  const ranked = rankNewsItems(OFF_TOPIC, 'latest uniben news', 0, 10);
  assert.equal(ranked.length, OFF_TOPIC.length, 'broad news request returns the feed');
});

test('maxResults caps the ranked output', () => {
  const feed = Array.from({ length: 20 }, (_, i) => ({
    title: `UNIBEN admission update ${i}`, summary: 'admission requirements score utme',
  }));
  assert.equal(rankNewsItems(feed, JAMB_QUERY, 0, 5).length, 5);
});
