import test from 'node:test';
import assert from 'node:assert/strict';
import { filterEvents, jstStart, normalizeEvent } from '../viewer/model.mjs';

const event = (id, time, zone = 'Asia/Tokyo', pref = 'JP-13') => normalizeEvent({ external_id: String(id), title: 'Synthetic match', venue_name: 'ＡＫＩＨＡＢＡＲＡ店', pref_code_source: pref, pref_name: '東京都', canonical_url: `https://www.bandai-tcg-plus.com/event/${id}`, start_datetime_source: time, timezone_source: zone });
const filters = { weekdays: [0,1,2,3,4,5,6], prefecture: '', venue: '', from: '', until: '', timeFrom: '', timeUntil: '' };

test('converts source-local timestamps to JST, including date rollover', () => {
  assert.deepEqual(jstStart({ start_datetime_source:'2026-11-18T23:30:00', timezone_source:'Asia/Shanghai' }), {date:'2026-11-19',time:'00:30',weekday:4,dateBasis:'JST'});
  assert.equal(jstStart({ start_datetime_source:'2026-11-18T13:00:00', timezone_source:'Etc/GMT-9' }).time, '13:00');
  assert.equal(jstStart({ start_datetime_source:'2026-11-18T04:00:00Z', timezone_source:'Asia/Shanghai' }).time, '13:00');
});

test('unknown or hidden times never become midnight matches', () => {
  for (const record of [
    {start_datetime_source:'2026-11-18'},
    {start_datetime_source:'2026-11-18T13:00:00',timezone_source:'Invalid/Zone'},
    {start_datetime_source:'2026-11-18T13:00:00',timezone_source:'Asia/Tokyo',start_datetime_hidden_type_source:2}
  ]) assert.equal(jstStart(record).time, null);
  assert.equal(jstStart({start_datetime_source:'2026-02-30'}).date,null);
  const unknown = normalizeEvent({external_id:'1',start_datetime_source:'2026-11-18'});
  assert.deepEqual(filterEvents([unknown],{...filters,timeFrom:'00:00'}),[]);
});

test('combines prefecture, weekday and half-open start-time range', () => {
  const rows=[event(1,'2026-11-18T09:00:00'),event(2,'2026-11-18T18:00:00'),event(3,'2026-11-21T13:00:00'),event(4,'2026-11-18T13:00:00','Asia/Tokyo','JP-27')];
  const result=filterEvents(rows,{...filters,prefecture:'JP-13',weekdays:[1,2,3,4,5],timeFrom:'09:00',timeUntil:'18:00'});
  assert.deepEqual(result.map(row=>row.id),['1']);
  assert.equal(filterEvents(rows,{...filters,weekdays:[]}).length,0);
});

test('date end is inclusive and venue search normalizes full-width text', () => {
  const rows=[event(1,'2026-11-18T13:00:00'),event(2,'2026-11-19T13:00:00')];
  assert.deepEqual(filterEvents(rows,{...filters,from:'2026-11-18',until:'2026-11-18',venue:'akihabara'}).map(row=>row.id),['1']);
});

test('only constructs detail links to the matching public event', () => {
  for(const canonical_url of ['javascript:alert(1)','https://example.com/event/1','https://www.bandai-tcg-plus.com/event/2','https://user:pass@www.bandai-tcg-plus.com/event/1']) assert.equal(normalizeEvent({external_id:'1',canonical_url}).url,null);
  assert.equal(event(1,'2026-11-18T13:00:00').url,'https://www.bandai-tcg-plus.com/event/1');
});
