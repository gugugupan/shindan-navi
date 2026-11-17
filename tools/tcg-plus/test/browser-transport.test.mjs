import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFetch } from '../browser-transport.mjs';

test('browser transport restricts requests to public directory and event-list endpoints', async () => {
  let calls = 0;
  const page = { url: () => 'https://www.bandai-tcg-plus.com/event', evaluate: async (_fn, target) => {
    calls++;
    assert.equal(new URL(target).pathname, '/api/user/event/list');
    return { status: 200, body: '{"success":{"event_list":[]}}' };
  } };
  const fetch = browserFetch(page);
  for (const url of ['https://example.com/', 'https://api.bandai-tcg-plus.com/api/user/profile', 'https://api.bandai-tcg-plus.com/api/user/event/apply/1']) await assert.rejects(fetch(url), /only permits/);
  await assert.rejects(fetch('https://api.bandai-tcg-plus.com/api/user/event/list', { method: 'POST' }), /only permits/);
  assert.equal(calls, 0);
  const response = await fetch('https://api.bandai-tcg-plus.com/api/user/event/list', { method: 'GET' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: { event_list: [] } });
  assert.equal(calls, 1);
});

test('browser transport rejects pages outside the normal TCG+ website', async () => {
  const fetch = browserFetch({ url: () => 'https://example.com', evaluate: () => assert.fail('must not execute') });
  await assert.rejects(fetch('https://api.bandai-tcg-plus.com/api/masterdata'), /must be on/);
});
