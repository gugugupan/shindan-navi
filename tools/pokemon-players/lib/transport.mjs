// Read-only GETs issued from a normal Chrome page on players.pokemon-card.com.
// Plain Node requests get a Cloudflare 403; the site's own page fetches the same public endpoints.
import { chromium } from 'playwright-core';

const ORIGIN = 'https://players.pokemon-card.com';
const ALLOWED = [/^\/event_search\?/];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openBrowserTransport({ profileDir, headless = false, delayMs = 1000, maxRequests = 1500, timeoutMs = 30000 }) {
  if (delayMs < 750) throw new Error('delayMs must be >= 750');
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', headless, locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const nav = await page.goto(`${ORIGIN}/event/search`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (!nav || nav.status() !== 200) {
    await ctx.close();
    throw new Error(`search page answered HTTP ${nav?.status() ?? 'none'}; not continuing`);
  }
  await page.waitForTimeout(3000);

  let count = 0;
  let last = 0;
  async function fetchJson(path) {
    if (!ALLOWED.some((re) => re.test(path))) throw new Error(`path not allowed: ${path}`);
    if (count >= maxRequests) throw new Error(`request budget ${maxRequests} exhausted`);
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    count += 1;
    last = Date.now();
    const res = await page.evaluate(async ({ url, timeoutMs }) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const r = await fetch(url, {
          headers: { Accept: 'application/json', 'X-Accept-Version': 'v1' },
          credentials: 'same-origin', signal: ac.signal,
        });
        return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
      } finally { clearTimeout(t); }
    }, { url: `${ORIGIN}${path}`, timeoutMs });
    // The API answers an empty result with HTTP 404 + JSON {code: 404}; collectChunk decides what that means.
    if (![200, 404].includes(res.status) || !(res.type ?? '').includes('json')) {
      throw new Error(`GET ${path} -> HTTP ${res.status} ${res.type}`);
    }
    return JSON.parse(res.text);
  }

  return { fetchJson, requests: () => count, close: () => ctx.close() };
}
