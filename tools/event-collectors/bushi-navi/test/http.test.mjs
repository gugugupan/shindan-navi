import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTransport, USER_AGENT } from '../lib/http.mjs';

function fake(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => r.body };
  };
  return { fetchImpl, calls };
}

test('sends the version header and a generic UA, keeps requests >= 1 s apart', async () => {
  let clock = 0;
  const waits = [];
  const { fetchImpl, calls } = fake([{ status: 200, body: '{"a":1}' }, { status: 200, body: '{"a":2}' }]);
  const t = makeTransport({ delayMs: 200, fetchImpl, now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; } });
  assert.deepEqual(await t.fetchJson('/x'), { a: 1 });
  assert.deepEqual(await t.fetchJson('/y'), { a: 2 });
  assert.equal(calls[0].url, 'https://api-user.bushi-navi.com/x');
  assert.equal(calls[0].init.headers['X-Accept-Version'], 'v1');
  assert.equal(calls[0].init.headers['User-Agent'], USER_AGENT);
  assert.deepEqual(waits, [1000]);
  assert.equal(t.requests(), 2);
});

test('retries 5xx and network errors, not 4xx', async () => {
  const wait = async () => {};
  const ok = fake([{ status: 503, body: '' }, new TypeError('fetch failed'), { status: 200, body: '{}' }]);
  assert.deepEqual(await makeTransport({ fetchImpl: ok.fetchImpl, wait }).fetchJson('/x'), {});
  assert.equal(ok.calls.length, 3);
  const bad = fake([{ status: 400, body: '{"error":{}}' }]);
  await assert.rejects(makeTransport({ fetchImpl: bad.fetchImpl, wait }).fetchJson('/x'), /HTTP 400/);
  assert.equal(bad.calls.length, 1);
});

test('stops at the request budget', async () => {
  const { fetchImpl } = fake([{ status: 200, body: '{}' }, { status: 200, body: '{}' }]);
  const t = makeTransport({ fetchImpl, maxRequests: 1, wait: async () => {} });
  await t.fetchJson('/x');
  await assert.rejects(t.fetchJson('/x'), /budget/);
});
