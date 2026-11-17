import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  containsContact, externalVenue, fingerprint, normalizeEvent, parseFee, parseStart, splitAddress,
} from '../lib/normalize.mjs';
import { buildOutputs, makeValidators } from '../lib/output.mjs';
import { parseRows, parseSeriesOptions } from '../lib/parse.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'fixtures', 'eventsearch-trimmed.html'), 'utf8');
const rows = parseRows(html);
const AT = '2026-11-17T18:22:53Z';
const events = rows.map((r) => normalizeEvent(r, AT));
const byShop = (name) => events.filter((_, i) => rows[i].shop_name.startsWith(name));

test('parses series options and every row', () => {
  assert.deepEqual(parseSeriesOptions(html), [
    'チャレンジ戦【2026年10月】', 'ファンミーティング【2026年10月】', 'ファンミーティング【2026年11月】', 'チャレンジ戦【2026年11月】',
  ]);
  assert.equal(rows.length, 7);
  assert.equal(rows[0].shop_name, 'トレキャット');
  assert.equal(rows[0].details['大会形式'], 'スイスドロー');
  assert.ok(!rows.some((r) => /MAP/.test(r.address)));
});

test('empty result and layout change', () => {
  assert.deepEqual(parseRows('<div class="eventSearch"><div class="shopList"></div></div>'), []);
  assert.throws(() => parseRows('<html></html>'), /layout changed/);
});

test('challenge row maps to a dated tournament at the store', () => {
  const e = events[0];
  assert.equal(e.group.event_type_code, 'challenge');
  assert.equal(e.group.category, 'tournament');
  assert.equal(e.group.name, 'チャレンジ戦');
  assert.equal(e.name, 'チャレンジ戦【2026年11月】');
  assert.equal(e.starts_on, '2026-11-18');
  assert.equal(e.starts_at, '2026-11-18T13:00:00+09:00');
  assert.equal(e.time_precision, 'datetime');
  assert.equal(e.capacity, 32);
  assert.equal(e.format_text, 'スイスドロー');
  assert.equal(e.fee_amount, null);
  assert.equal(e.venue.name, 'トレキャット');
  assert.match(e.venue.region_code, /^JP-\d{2}$/);
  assert.match(e.venue.postal_code, /^\d{3}-\d{4}$/);
  assert.equal(e.registration_status, 'unknown');
  assert.equal(e.id, `conan:${e.external_id}`);
});

test('fan meeting is casual; 参加条件なし is not treated as free', () => {
  const [e] = byShop('カードラボ水戸店');
  assert.equal(e.group.event_type_code, 'fan_meeting');
  assert.equal(e.group.category, 'casual');
  assert.equal(e.fee_text, 'なし');
  assert.equal(e.fee_amount, null);
});

test('external venue with name and address replaces the store', () => {
  const [e] = byShop('カードショップトレカアリーナ');
  assert.equal(e.venue.name, 'カードショップ トレカスタジオ');
  assert.equal(e.venue.region_name, '兵庫県');
  assert.match(e.source_status_text, /external_venue=1/);
});

test('external venue given as address only keeps the store name', () => {
  const e = byShop('A.M.').find((x) => /external_venue/.test(x.source_status_text));
  assert.equal(e.venue.name, 'A.M.');
  assert.match(e.venue.address, /^滋賀県草津市野路/);
  assert.match(e.source_status_text, /external_venue=address_only/);
  assert.equal(externalVenue('[外部会場]での開催となります', 'X').flag, 'unparsed');
  assert.equal(externalVenue('受付は10分前まで', 'X'), null);
});

test('free stated → 0 JPY; contact text is dropped', () => {
  const [free] = byShop('TSUTAYA AVクラブ 玉名店');
  assert.equal(free.fee_amount, 0);
  assert.equal(free.fee_currency, 'JPY');
  const [contact] = byShop('ショップ娯楽屋');
  assert.equal(contact.fee_text, null);
  assert.equal(contact.fee_amount, null);
});

test('fee, date and address helpers', () => {
  assert.equal(parseFee('無料'), 0);
  assert.equal(parseFee('0円'), 0);
  assert.equal(parseFee('５００円'), 500);
  assert.equal(parseFee('参加費1,000円'), 1000);
  assert.equal(parseFee('席料500円'), null);
  assert.equal(parseFee('1パック購入'), null);
  assert.equal(parseFee('なし'), null);
  assert.deepEqual(parseStart('2026年11月27日 9:00'), { date: '2026-11-27', at: '2026-11-27T09:00:00+09:00' });
  assert.deepEqual(parseStart('2026年12月1日'), { date: '2026-12-01', at: null });
  assert.throws(() => parseStart('近日'), /unparsed/);
  assert.deepEqual(splitAddress('〒658-0053 兵庫県神戸市東灘区住吉宮町3-15-18'), { postal_code: '658-0053', address: '兵庫県神戸市東灘区住吉宮町3-15-18' });
  assert.ok(containsContact('TEL 03-1234-5678'));
  assert.ok(containsContact('shop@example.com'));
  assert.ok(!containsContact('兵庫県神戸市東灘区住吉宮町3-15-18'));
});

test('fingerprint is stable across spacing/width changes and differs per start', () => {
  const r = rows[0];
  const id = fingerprint(r);
  assert.equal(fingerprint({ ...r, shop_name: ` ${r.shop_name} ` }), id);
  assert.equal(fingerprint({ ...r, open_date: r.open_date.replace(/\d/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0)) }), id);
  assert.notEqual(fingerprint({ ...r, open_date: '2026年11月18日 14:00' }), id);
  assert.equal(new Set(rows.map(fingerprint)).size, rows.length);
});

test('outputs validate against contracts and reject contact leaks', () => {
  const v = makeValidators(resolve(here, '..', '..', '..'));
  const run = {
    game_code: 'CONAN', source_code: 'conan_official', fetched_at: AT, window: { from: '2026-11-18', until: '2027-02-18' },
    query: {}, source_total: null, record_count: events.length, complete: false, collector_version: 't', notes: [],
  };
  const files = buildOutputs(events, run, v);
  assert.deepEqual(Object.keys(files).sort(), ['2026-11.json', '_run.json']);
  const leak = [{ ...events[0], fee_text: '予約は 090-1234-5678 まで' }];
  assert.throws(() => buildOutputs(leak, run, v), /contact-like/);
});
