// One-shot investigation: open a URL in a visible Chrome with the dedicated profile,
// record same-origin XHR/fetch responses and a screenshot. Does not click anything.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'https://players.pokemon-card.com/event/search';
const outDir = join(here, 'out', `probe-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });

const ctx = await chromium.launchPersistentContext(join(here, '.session', 'chrome'), {
  channel: 'chrome',
  headless: process.argv.includes('--headless'),
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const seen = [];
page.on('response', async (res) => {
  const req = res.request();
  if (!['xhr', 'fetch'].includes(req.resourceType())) return;
  const entry = { url: res.url(), status: res.status(), type: res.headers()['content-type'] ?? null };
  try { if ((entry.type ?? '').includes('json')) entry.body = await res.json(); } catch { /* body gone */ }
  seen.push(entry);
});
const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(8000);
writeFileSync(join(outDir, 'probe.json'), JSON.stringify({
  url, status: nav?.status() ?? null, title: await page.title(), finalUrl: page.url(), responses: seen,
}, null, 2));
await page.screenshot({ path: join(outDir, 'page.png'), fullPage: false });
writeFileSync(join(outDir, 'text.txt'), (await page.locator('body').innerText()).slice(0, 20000));
await ctx.close();
console.log(outDir);
