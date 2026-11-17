import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSeriesTrial, parseTrialOptions } from '../trial.mjs';

// Synthetic contract examples, not live TCG+ event records.
const master = { code: 200, game_title: [{ id: 8, title: 'ONE PIECE CARD GAME', language_code: 'JA', game_title_code: 'fixture', account: 'private' }] };
const rows = (from, count) => Array.from({ length: count }, (_, i) => ({ event_series_id: from + i, title: `Synthetic series ${from + i}`, apply_start_date: '2026-11-01', apply_end_date: '', display_apply_period: '', series_type: 1, player_id: 'private' }));
const page = (list, total) => ({ code: 200, event_series_list: list, total: String(total) });
const defaults = { gameTitleId: 8, maxPages: 3 };

function harness(responses) {
  const urls = [];
  return { urls, dependencies: {
    delay: async () => {},
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(options.headers, { Accept: 'application/json' });
      assert.equal(url.origin, 'https://api.bandai-tcg-plus.com');
      assert.ok(['/api/masterdata', '/api/user/eventseries'].includes(url.pathname));
      urls.push(new URL(url));
      assert.ok(responses.length, 'unexpected extra request');
      const value = responses.shift();
      return value instanceof Response ? value : Response.json({ success: value });
    }
  } };
}

test('collects offset pages and only projects public series fields', async () => {
  const h = harness([master, page(rows(1, 11), 13), page(rows(12, 2), 13)]);
  const report = await collectSeriesTrial(defaults, h.dependencies);
  assert.deepEqual(h.urls.slice(1).map(url => url.searchParams.get('offset')), ['0', '11']);
  assert.equal(report.collected, 13);
  assert.equal(report.multiple_pages_fetched, true);
  assert.equal(report.complete_series_listing, true);
  assert.equal(report.series[0].canonical_url, 'https://www.bandai-tcg-plus.com/series/1');
  assert.ok(!JSON.stringify(report).includes('private'));
  assert.ok(!('starts_at' in report.series[0]));
});

test('page cap and empty responses report their actual coverage', async () => {
  const partial = harness([master, page(rows(1, 11), 20)]);
  const report = await collectSeriesTrial({ ...defaults, maxPages: 1 }, partial.dependencies);
  assert.equal(report.complete_series_listing, false);
  assert.equal(report.multiple_pages_fetched, false);
  const empty = harness([master, page([], 0)]);
  assert.equal((await collectSeriesTrial(defaults, empty.dependencies)).status, 'series_trial_empty');
});

test('fails on repeated pages, drifting totals, missing IDs and premature empty pages', async () => {
  for (const [responses, message] of [
    [[master, page(rows(1, 11), 22), page(rows(1, 11), 22)], /Repeated/],
    [[master, page(rows(1, 11), 22), page(rows(12, 11), 23)], /total changed/],
    [[master, page([{ title: 'Missing ID' }], 1)], /Invalid event_series_id/],
    [[master, page(rows(1, 11), 22), page([], 22)], /Short or empty/],
    [[master, page([], 'garbage')], /Invalid event-series total/]
  ]) await assert.rejects(collectSeriesTrial(defaults, harness(responses).dependencies), message);
});

test('rejects wrong game, HTTP errors, HTML and API error envelopes without leaking body', async () => {
  for (const [responses, message] of [
    [[{ ...master, game_title: [{ id: 8, title: 'Other Game' }] }], /not verified/],
    [[new Response('private', { status: 403 })], /HTTP 403/],
    [[new Response(null, { status: 204 })], /missing response body/],
    [[new Response('<html>private</html>')], /invalid JSON/],
    [[Response.json({ error: { token: 'private' } })], /unexpected API envelope/]
  ]) {
    await assert.rejects(collectSeriesTrial(defaults, harness(responses).dependencies), error => message.test(error.message) && !error.message.includes('private'));
  }
});

test('network failure is bounded to one request and hides arbitrary error text', async () => {
  let calls = 0;
  await assert.rejects(collectSeriesTrial(defaults, { delay: async () => {}, fetchImpl: async () => {
    calls++;
    throw Object.assign(new Error('private credentials'), { cause: { code: 'ENOTFOUND' } });
  } }), /failed \(ENOTFOUND\)/);
  assert.equal(calls, 1);
});

test('rejects invalid trial bounds and unsupported options', () => {
  for (const args of [['--max-pages', '0'], ['--max-pages', '21'], ['--game-title-id', '-1'], ['--max-pages'], ['--url', 'https://example.com']]) assert.throws(() => parseTrialOptions(args));
  assert.deepEqual(parseTrialOptions([]), { ...defaults, help: false });
});
