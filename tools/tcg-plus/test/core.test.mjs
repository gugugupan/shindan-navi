import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPage, isTcgUrl, jevRequest, parseEnv, parseOptions, redact, safeUrl } from '../core.mjs';

test('rejects lookalike hosts and credential-bearing navigation', () => {
  for (const url of ['https://bandai-tcg-plus.com.evil.test/', 'https://evilbandai-tcg-plus.com/', 'http://www.bandai-tcg-plus.com/', 'https://user:password@www.bandai-tcg-plus.com/']) assert.equal(isTcgUrl(url), false);
  assert.equal(isTcgUrl('https://www.bandai-tcg-plus.com/series/8608'), true);
  assert.throws(() => parseOptions(['--url', 'https://example.com']));
  assert.throws(() => parseOptions(['--headless']));
});

test('network URL logging strips credentials and fragments but keeps public filter IDs', () => {
  const url = new URL(safeUrl('https://user:pass@www.bandai-tcg-plus.com/event?game_id=19&access_token=secret&email=pan@example.com&code=oauth-code&state=oauth-state#token'));
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.hash, '');
  assert.equal(url.searchParams.get('game_id'), '19');
  assert.equal(url.searchParams.get('access_token'), '[redacted]');
  assert.equal(url.searchParams.get('email'), '[redacted]');
  assert.equal(url.searchParams.get('code'), '[redacted]');
  assert.equal(url.searchParams.get('state'), '[redacted]');
});

test('redacts nested credentials and personal fields from JSON without discarding event names', () => {
  const result = redact({ event_name: 'Standard Battle', credentials: { token: 'secret' }, events: [{ fee: 300, address: 'private', accessToken: 'secret' }], message: 'Bearer secret pan@example.com' });
  assert.equal(result.event_name, 'Standard Battle');
  assert.equal(result.credentials, '[redacted]');
  assert.equal(result.events[0].fee, 300);
  assert.equal(result.events[0].address, '[redacted]');
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!JSON.stringify(result).includes('pan@example.com'));
});

test('dotenv parser does not evaluate shell syntax', () => {
  assert.deepEqual(parseEnv('# comment\nTYPESAFE_API_KEY="$(not-a-command)"\nexport TYPESAFE_MODEL=jev-latest'), {
    TYPESAFE_API_KEY: '$(not-a-command)', TYPESAFE_MODEL: 'jev-latest'
  });
});

test('Jev sees a bounded sanitized snapshot and only classifies observed page state', () => {
  const body = jevRequest({ url: 'https://www.bandai-tcg-plus.com/home?token=secret', text: 'x'.repeat(30000), buttons: [] });
  assert.equal(body.questions.page_kind.type, 'choice');
  assert.equal(JSON.parse(body.state).text.length, 18000);
  assert.ok(!body.state.includes('secret'));
  assert.ok(body.questions.page_kind.criteria.INITIAL_SELECTION);
});

test('Jev request uses the server-side key once, handles choice and never leaks error response bodies', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.ok(!options.body.includes('test-key'));
    return { ok: true, json: async () => ({ answers: { page_kind: { choice: 'INITIAL_SELECTION', probabilities: { INITIAL_SELECTION: 0.98 } } } }) };
  };
  const result = await classifyPage({ text: 'Select game' }, { key: 'test-key', fetchImpl });
  assert.equal(result.answer.choice, 'INITIAL_SELECTION');
  assert.equal(calls, 1);
  await assert.rejects(classifyPage({}, { key: 'test-key', fetchImpl: async () => ({ ok: false, status: 401 }) }), /^Error: Jev HTTP 401; response body omitted\.$/);
});
