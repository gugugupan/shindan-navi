import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildOutputs, classifySeries, isJstZone, loadValidators, normalizeEvent, toJst, writeOutputs } from '../normalize.mjs';

// Fixtures are synthetic projected records shaped like live /api/user/event/list rows.
const fixtures = JSON.parse(await fs.readFile(new URL('./fixtures/projected-events.json', import.meta.url), 'utf8'));
const fetchedAt = '2026-11-18T00:00:00Z';
const byId = Object.fromEntries(fixtures.map(r => [r.external_id, r]));
const norm = id => normalizeEvent(byId[id], { fetchedAt });
const validators = await loadValidators();
const window = { from: '2026-11-18', until: '2027-02-18' };

test('timed store meetup maps to a contract event with JST offset and explicit open status', () => {
  const { event } = norm('900000101');
  assert.equal(event.id, 'tcgp:900000101');
  assert.equal(event.starts_at, '2026-12-05T13:00:00+09:00');
  assert.equal(event.time_precision, 'datetime');
  assert.deepEqual(event.group, { source_id: '9001', name: '交流会（12月開催）', category: 'casual', event_type_code: 'meetup' });
  assert.equal(event.venue.region_code, 'JP-13');
  assert.equal(event.venue.postal_code, '160-0023');
  assert.equal(event.venue.address, '東京都新宿区西新宿1-1-1 2F');
  assert.equal(event.capacity, 16);
  assert.equal(event.fee_amount, null);
  assert.equal(event.registration_method, 'first_come');
  assert.equal(event.registration_opens_at, '2026-10-01T00:00:00+09:00');
  assert.equal(event.registration_status, 'open');
  assert.equal(event.event_status, 'scheduled');
  assert.ok(validators.events([event]), validators.ajv.errorsText(validators.events.errors));
});

test('hidden time, hidden capacity and full events stay unknown or waitlist', () => {
  const { event } = norm('900000102');
  assert.equal(event.name, 'CHAMPIONSHIP26-27 エリア予選 / 【神奈川会場】SAMPLE会場');
  assert.equal(event.time_precision, 'date');
  assert.equal(event.starts_at, null);
  assert.equal(event.capacity, null);
  assert.equal(event.venue.postal_code, null);
  assert.equal(event.format_text, 'Official Rule / Standard Regulation');
  assert.equal(event.group.event_type_code, 'championship_qualifier');
  assert.equal(event.registration_method, 'other');
  assert.equal(event.registration_status, 'waitlist');
});

test('online events have no venue; closed status only from a post-acceptance status id', () => {
  const { event } = norm('900000103');
  assert.equal(event.attendance_mode, 'online');
  assert.equal(event.venue, null);
  assert.equal(event.registration_status, 'closed');
  assert.equal(event.registration_method, 'lottery');
});

test('non-UTC+9 source zone drops the time; cancelled, team and off-platform fields stay unknown', () => {
  const { event } = norm('900000104');
  assert.equal(event.starts_on, '2027-01-09');
  assert.equal(event.starts_at, null);
  assert.equal(event.event_status, 'cancelled');
  assert.equal(event.registration_status, 'unknown');
  assert.equal(event.registration_platform, null);
  assert.equal(event.registration_url, null);
  assert.equal(event.capacity, null);
  assert.equal(event.fee_amount, null);
  assert.equal(event.group.event_type_code, 'standard_battle');
});

test('Etc/GMT-9 counts as JST; future application start is not_open', () => {
  const { event } = norm('900000105');
  assert.equal(event.starts_at, '2027-02-17T18:30:00+09:00');
  assert.equal(event.registration_status, 'not_open');
  assert.equal(event.group.category, 'teaching');
});

test('fully hidden start dates are skipped, not guessed', () => {
  assert.deepEqual(norm('900000106'), { skip: 'start_date_hidden' });
});

test('series classification and time helpers', () => {
  assert.deepEqual(classifySeries('ユニチケゲットバトル（11月開催）'), { category: 'tournament', event_type_code: 'unichike_get_battle' });
  assert.deepEqual(classifySeries('CHAMPIONSHIP26-27'), { category: 'tournament', event_type_code: 'championship' });
  assert.deepEqual(classifySeries('謎のイベント'), { category: 'unknown', event_type_code: null });
  assert.equal(isJstZone('Asia/Yakutsk', '2026-12-01'), true);
  assert.equal(isJstZone('Asia/Shanghai', '2026-12-01'), false);
  assert.equal(isJstZone('Not/AZone', '2026-12-01'), false);
  assert.equal(toJst('2026-11-30T15:00:00+00:00'), '2026-12-01T00:00:00+09:00');
  assert.throws(() => toJst('2026-11-30 15:00'));
});

const report = (records, extra = {}) => ({
  status: 'collected', started_at: '2026-11-18T00:00:00.123Z',
  selected_game: { external_id: '8', title: 'ONE PIECE CARD GAME', language_code: 'JA', game_title_code: 'one_piece_card_game.ja' },
  source_query: { game_title_id: '8', 'country_code[]': 'JP', limit: '100', offset: '0', application_open_flg: '0', order: '1', start_date: '2026-11-18' },
  coverage: { complete_for_source_total: true, source_total: records.length, collected: records.length, pages: 1 },
  ...extra
});

test('buildOutputs writes sorted month files and a valid run only for complete collections', async () => {
  const records = fixtures.filter(r => r.game_code === 'OPCG');
  const { files, run } = buildOutputs({ records, report: report(records), game: 'OPCG', window, validators });
  assert.deepEqual([...files.keys()].sort(), ['2026-11.json', '2027-01.json', '2027-02.json', '_run.json']);
  assert.equal(run.complete, true);
  assert.equal(run.record_count, 3);
  assert.equal(run.source_total, 4);
  assert.equal(run.fetched_at, '2026-11-18T00:00:00Z');
  assert.ok(files.get('2026-11.json').endsWith('\n'));

  assert.throws(() => buildOutputs({ records, report: report(records, { coverage: { complete_for_source_total: false, source_total: 9, collected: 4 } }), game: 'OPCG', window, validators }), /not complete/);
  assert.throws(() => buildOutputs({ records, report: report(records, { status: 'failed' }), game: 'OPCG', window, validators }), /status/);
  assert.throws(() => buildOutputs({ records, report: report(records), game: 'UATCG', window, validators }), /another game/);
  const late = report(records); late.source_query = { ...late.source_query, start_date: '2026-11-20' };
  assert.throws(() => buildOutputs({ records, report: late, game: 'OPCG', window, validators }), /window/);
  const broken = records.map(r => ({ ...r, pref_code_source: 'JP-13', venue_name: 'x', external_id: r.external_id }));
  broken[0] = { ...broken[0], game_code: 'OPCG', event_series_title: null, title: null };
  const partial = buildOutputs({ records: broken, report: report(broken), game: 'OPCG', window, validators });
  assert.deepEqual(partial.skipped, { missing_name: 1, start_date_hidden: 1 });
  assert.match(partial.run.notes.join('\n'), /missing_name=1/);
});

test('writeOutputs replaces the game directory contents', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tcg-events-write-'));
  try {
    await fs.writeFile(path.join(dir, '2026-10.json'), '[]\n');
    await writeOutputs(dir, new Map([['2026-11.json', '[]\n'], ['_run.json', '{}\n']]));
    assert.deepEqual((await fs.readdir(dir)).sort(), ['2026-11.json', '_run.json']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
