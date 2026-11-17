// Open a few collected events' detail pages in Chrome and compare with data/events/PTCG.
// Usage: node spotcheck.mjs <event id> [...]   (ids like ptcg:1169952)
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '..', '..', 'data', 'events', 'PTCG');
const all = readdirSync(dataDir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
  .flatMap((f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8')));
const wanted = process.argv.slice(2).map((id) => all.find((e) => e.id === id) ?? { id, missing: true });

const ctx = await chromium.launchPersistentContext(join(here, '.session', 'chrome'), {
  channel: 'chrome', headless: false, locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const hhmm = (s) => (s ? s.slice(11, 16) : null);
for (const e of wanted) {
  if (e.missing) { console.log(`${e.id}: not in data`); continue; }
  const detail = page.waitForResponse((r) => r.url().includes('/event_detail_search'), { timeout: 30000 });
  await page.goto(e.source_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const d = (await (await detail).json()).event;
  await page.waitForTimeout(2500);
  const body = await page.locator('body').innerText();
  const checks = {
    id: String(d.id) === e.external_id,
    // The site titles organizer events (type 6) with orgEventTitle.
    title: (d.eventTypeId === 6 ? d.orgEventTitle : d.eventTitle) === e.name,
    date: d.eventDate.date.slice(0, 10) === e.starts_on,
    time_on_page: body.includes(`${Number(hhmm(e.starts_at)?.slice(0, 2))}:${hhmm(e.starts_at)?.slice(3)}`) || body.includes(hhmm(e.starts_at) ?? '\u0000'),
    address: d.address === e.venue?.address,
    zip: d.zipCode === e.venue?.postal_code,
    fee: d.entryFee === e.fee_text,
    capacity: Number(d.capacity) === e.capacity,
    type: d.eventTypeName === e.group.name,
    cancelled: (d.discontinuanceFlg === 1) === (e.event_status === 'cancelled'),
  };
  const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(`${e.id} ${e.starts_on} ${e.name} :: ${bad.length ? `MISMATCH ${bad.join(',')}` : 'all match'}`);
  if (bad.length) console.log(JSON.stringify({ detail: { title: d.eventTitle, date: d.eventDate.date, address: d.address, zip: d.zipCode, fee: d.entryFee, capacity: d.capacity, type: d.eventTypeName, disc: d.discontinuanceFlg } }));
  await page.waitForTimeout(1500);
}
await ctx.close();
