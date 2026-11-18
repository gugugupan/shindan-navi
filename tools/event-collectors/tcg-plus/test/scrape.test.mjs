import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectCompetitions, eventListUrl, parseScrapeOptions, prefectureNames, projectEvent, resolveGameTitle, runScrape } from '../scrape.mjs';
import { splitBrowserArgs } from '../scrape-browser.mjs';

// All API responses here are synthetic; live validation is tracked separately.
const defaults = parseScrapeOptions([]);
const master = { code: 200, game_title: [{ id: 8, title: 'ONE PIECE CARD GAME', language_code: 'JA' }] };
const rows = (start, count) => Array.from({ length: count }, (_, i) => ({ id: start + i, event_title: `Synthetic event ${start + i}`, event_series_id: 8608, organizer_name: 'Synthetic venue', start_datetime: '2026-11-20 13:00:00', timezone: 'Asia/Tokyo', rankings: [{ email: 'private@example.com' }], player_id: 'private' }));
const page = (start, count, total) => ({ code: 200, event_list: rows(start, count), total: String(total) });

function harness(responses, memberships = []) {
  const urls = [];
  return { urls, dependencies: {
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      urls.push(new URL(url));
      assert.equal(options.method, 'GET');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(url.origin, 'https://api.bandai-tcg-plus.com');
      assert.ok(['/api/masterdata', '/api/user/event/list', '/api/user/event/list/params'].includes(url.pathname));
      if (url.pathname === '/api/user/event/list/params') return Response.json({ success: { code: 200, event_series_with_game_title_id: memberships } });
      assert.ok(responses.length, 'unexpected extra request');
      return Response.json({ success: responses.shift() });
    }
  } };
}

test('collects every source page, including closed applications, without region or weekday restrictions', async () => {
  const h = harness([master, page(1, 20, 43), page(21, 20, 43), page(41, 3, 43)]);
  const result = await collectCompetitions(defaults, h.dependencies);
  assert.equal(result.events.length, 43);
  assert.deepEqual(result.coverage, { complete_for_source_total: true, source_total: 43, collected: 43, pages: 3 });
  assert.deepEqual(h.urls.slice(1).map(u => u.searchParams.get('offset')), ['0', '20', '40']);
  for (const url of h.urls.slice(1)) {
    assert.equal(url.searchParams.get('country_code[]'), 'JP');
    assert.equal(url.searchParams.get('application_open_flg'), '0');
    assert.equal(url.searchParams.has('pref_code'), false);
    assert.equal(url.searchParams.has('start_date'), false);
  }
  assert.equal(JSON.stringify(result.events).includes('private'), false);
  assert.equal(result.events[0].registration_status, 'unknown');
});

test('rejects duplicates, drifting totals, early short pages, missing IDs and wrong game/country', async () => {
  for (const [responses, message] of [
    [[master, page(1, 20, 40), page(1, 20, 40)], /Duplicate/],
    [[master, page(1, 20, 40), page(21, 20, 41)], /total changed/],
    [[master, page(1, 20, 40), page(21, 0, 40)], /Premature/],
    [[master, { ...page(1, 1, 1), event_list: [{ title: 'No ID' }] }], /Invalid event ID/],
    [[master, { ...page(1, 1, 1), event_list: [{ ...rows(1, 1)[0], game_title_id: 9 }] }], /another game/],
    [[master, { ...page(1, 1, 1), event_list: [{ ...rows(1, 1)[0], country_code: 'US' }] }], /another country/],
    [[{ ...master, game_title: [{ id: 8, title: 'ONE PIECE', language_code: 'EN' }] }], /0 Japanese-edition titles/],
    [[master, { ...page(1, 1, 1), event_list: [{ ...rows(1, 1)[0], game_title_language: 'EN' }] }], /another language/],
    [[{ code: 500, game_title: master.game_title }], /Unexpected source API code/]
  ]) await assert.rejects(collectCompetitions(defaults, harness(responses).dependencies), message);
});

test('page budget exhaustion fails rather than returning a partial competition list', async () => {
  await assert.rejects(collectCompetitions({ ...defaults, maxPages: 1 }, harness([master, page(1, 20, 40)]).dependencies), /Page budget exhausted/);
});

test('includes a shared BANDAI event only with explicit ONE PIECE series membership', async () => {
  const shared = { ...rows(1, 1)[0], game_title_id: '14', event_series_id: '9093' };
  const h = harness([master, { code: 200, total: 1, event_list: [shared] }], [{ game_title_id: 14, event_series_id: 9093, event_series_game_title_ids: '6,7,8,9,14,15' }]);
  const result = await collectCompetitions(defaults, h.dependencies);
  assert.equal(result.events[0].source_game_title_id, '14');
  assert.equal(result.events[0].game_scope_match, 'series_game_membership');
  assert.equal(result.events[0].game_code, 'OPCG');
  const wrong = harness([master, { code: 200, total: 1, event_list: [shared] }], [{ game_title_id: 14, event_series_id: 9093, event_series_game_title_ids: '6,9,14' }]);
  await assert.rejects(collectCompetitions(defaults, wrong.dependencies), /another game/);
});

test('source dates and unknown fees remain source values; personal data is omitted', () => {
  const event = projectEvent({ ...rows(1, 1)[0], start_datetime_hidden_type: 2, entry_fee: null, max_join_count: 32, is_capacity_hidden: true, street_address: 'Synthetic public venue address' });
  assert.equal(event.start_datetime_source, '2026-11-20 13:00:00');
  assert.equal(event.start_datetime_hidden_type_source, 2);
  assert.equal(event.entry_fee_source, null);
  assert.equal(event.capacity_hidden_source, true);
  assert.equal(event.street_address, 'Synthetic public venue address');
  assert.equal(event.canonical_url, 'https://www.bandai-tcg-plus.com/event/1');
  assert.equal('rankings' in event, false);
  assert.equal('player_id' in event, false);
});

test('resolves prefecture names only from official Japanese masterdata', () => {
  const index = prefectureNames({ area: { 1: { country_list: { JP: { country_code: 'JP', pref_list: { 'JP-13': { pref_code: 'JP-13', name: '東京都' } } } } } } });
  const event = projectEvent({ ...rows(1, 1)[0], pref_code: 'JP-13' }, index);
  assert.equal(event.pref_name, '東京都');
  assert.equal(projectEvent({ ...rows(1, 1)[0], pref_code: 'JP-99' }, index).pref_name, null);
  assert.equal(projectEvent({ ...rows(1, 1)[0], pref_code: 'JP-13', pref_name: 'Explicit source name' }, index).pref_name, 'Explicit source name');
});

test('empty source is explicit and no date range is silently assumed', async () => {
  const result = await collectCompetitions(defaults, harness([master, page(1, 0, 0)]).dependencies);
  assert.equal(result.events.length, 0);
  assert.equal(result.coverage.source_total, 0);
  const url = eventListUrl(parseScrapeOptions(['--from', '2026-11-01', '--until', '2026-11-30']), 0);
  assert.equal(url.searchParams.get('start_date'), '2026-11-01');
  assert.equal(url.searchParams.get('end_date'), '2026-11-30');
});

test('accepts observed event-list title and fee names without inventing a registration status', () => {
  const event = projectEvent({ id: 8501295, event_series_title: 'Observed list field shape', entryFee: '0.000', applicationOpen: '1', start_datetime: '2026-11-18T11:00:00', timezone: 'Asia/Tokyo' });
  assert.equal(event.title, 'Observed list field shape');
  assert.equal(event.entry_fee_source, '0.000');
  assert.equal(event.application_open_source, '1');
  assert.equal(event.registration_status, 'unknown');
});

test('failed collection writes diagnostics without a partial or misleading empty data file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tcg-events-failure-'));
  try {
    const { report, out, exitCode } = await runScrape(defaults, { outRoot: root, log: () => {}, collector: async () => { throw new Error('Synthetic failed page'); } });
    assert.equal(exitCode, 1);
    assert.equal(report.status, 'failed');
    assert.deepEqual(await fs.readdir(out), ['report.json']);
    assert.equal('data_file' in report, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('successful collection exports a standalone JSON array and its schema', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tcg-events-success-'));
  try {
    const collector = options => collectCompetitions(options, harness([master, page(1, 1, 1)]).dependencies);
    const { out, report, exitCode } = await runScrape(defaults, { outRoot: root, log: () => {}, collector });
    assert.equal(exitCode, 0);
    assert.equal(report.status, 'collected');
    const data = JSON.parse(await fs.readFile(path.join(out, 'competitions.json'), 'utf8'));
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(out, 'competitions.schema.json'), 'utf8')).type, 'array');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('resolves each game title from masterdata and rejects a mismatched ID', () => {
  const directory = { game_title: [{ id: 8, title: 'ONE PIECE CARD GAME', language_code: 'JA' }, { id: 4, title: 'ONE PIECE CARD GAME', language_code: 'EN' }, { id: 9, title: 'UNION ARENA', language_code: 'JA' }] };
  assert.equal(resolveGameTitle(directory, 'OPCG').id, 8);
  assert.equal(resolveGameTitle(directory, 'UATCG').id, 9);
  assert.throws(() => resolveGameTitle(directory, 'UATCG', 8), /not the Japanese UATCG/);
  assert.throws(() => resolveGameTitle(directory, 'CONAN'), /0 Japanese-edition titles for CONAN/);
  assert.equal(parseScrapeOptions(['--game', 'UATCG']).game, 'UATCG');
});

test('UNION ARENA collection uses the resolved ID and labels records UATCG', async () => {
  const uaMaster = { code: 200, game_title: [{ id: 9, title: 'UNION ARENA', language_code: 'JA' }] };
  const h = harness([uaMaster, { code: 200, total: 1, event_list: [{ ...rows(1, 1)[0], game_title_id: '9', game_format_ids: [15] }] }]);
  const result = await collectCompetitions(parseScrapeOptions(['--game', 'UATCG']), h.dependencies);
  assert.equal(h.urls[1].searchParams.get('game_title_id'), '9');
  assert.equal(result.events[0].game_code, 'UATCG');
  assert.equal(result.query.game_title_id, '9');
});

test('rejects invalid dates, limits and unsupported filters before fetching', () => {
  for (const args of [['--game', 'PTCG'], ['--from', '2026-02-30'], ['--until'], ['--from', '2026-12-01', '--until', '2026-11-01'], ['--page-size', '500'], ['--max-pages', '10001'], ['--game-title-id', '0'], ['--country', 'US']]) assert.throws(() => parseScrapeOptions(args));
});

test('browser profile comes from --profile, then TCG_PLUS_PROFILE, then the tool default', () => {
  assert.equal(splitBrowserArgs(['--profile', '/tmp/p', '--game', 'OPCG'], {}).profile, '/tmp/p');
  assert.deepEqual(splitBrowserArgs(['--profile', '/tmp/p', '--game', 'OPCG'], {}).rest, ['--game', 'OPCG']);
  assert.equal(splitBrowserArgs([], { TCG_PLUS_PROFILE: '/tmp/env' }).profile, '/tmp/env');
  assert.match(splitBrowserArgs([], {}).profile, /\.session\/chrome$/);
  assert.throws(() => splitBrowserArgs(['--profile'], {}));
});
