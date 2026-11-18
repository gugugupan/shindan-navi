import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const geo = async (cf?: { country?: string; regionCode?: string }) => {
  const req = new Request('http://localhost/api/v1/geo');
  if (cf) Object.defineProperty(req, 'cf', { value: cf });
  const res = await worker.fetch(req, {} as never);
  return { status: res.status, cache: res.headers.get('cache-control'), body: (await res.json()) as { region_code: string | null } };
};

describe('GET /api/v1/geo', () => {
  it('maps a Japanese Cloudflare region to an ISO 3166-2:JP code', async () => {
    expect(await geo({ country: 'JP', regionCode: '13' })).toEqual({ status: 200, cache: 'private, no-store', body: { region_code: 'JP-13' } });
    expect((await geo({ country: 'JP', regionCode: '1' })).body.region_code).toBe('JP-01');
  });
  it('returns null outside Japan, for unknown regions or without cf data', async () => {
    for (const cf of [{ country: 'US', regionCode: '13' }, { country: 'JP', regionCode: '48' }, { country: 'JP', regionCode: 'CA' }, { country: 'JP' }, undefined])
      expect((await geo(cf)).body.region_code).toBeNull();
  });
});
