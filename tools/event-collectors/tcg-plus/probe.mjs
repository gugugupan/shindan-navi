import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { lookup } from 'node:dns/promises';
import { startControl } from './control.mjs';
import { classifyPage, isTcgUrl, jsonShape, parseEnv, parseOptions, redact, redactText, safeUrl } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const PROFILE = path.join(HERE, '.session/chrome');
const HELP = `TCG+ persistent browser probe
  npm start                       Visible Chrome with a dedicated saved profile
  npm start -- --url URL           Open a specific HTTPS TCG+ page
  npm start -- --save-json         Also save sanitized TCG+ JSON samples locally
  npm start -- --control           Allow workspace-local inspection/navigation commands
  npm start -- --headless --once   Capture once and close (no interactive actions)
  npm run doctor                  Check Node, Playwright, Chrome and DNS

Interactive commands:
  snapshot       Save visible text, control options, links and a screenshot
  status         Current URL and number of network responses
  select N VALUE Set an observed native select by snapshot index and exact value
  goto URL       Navigate the current tab to a TCG+ URL, preserving its session
  reload         Reload the current page once
  network        List the last 15 observed fetch/XHR responses
  jev            Ask Jev to classify this page once; never clicks anything
  quit           Save a final snapshot and close Chrome cleanly

Interact with the visible browser normally. No automatic clicks or retry loops.
CHROME_EXECUTABLE can select an installed Chrome executable. API keys stay server-side.`;

async function settings() {
  let env = {};
  try { env = parseEnv(await fs.readFile(path.join(ROOT, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...env, ...process.env };
}

async function doctor(env) {
  const checks = { node: process.version, nodeSupported: Number(process.versions.node.split('.')[0]) >= 20 };
  try { await import('playwright-core'); checks.playwright = 'installed'; }
  catch { checks.playwright = 'missing: run npm install in tools/event-collectors/tcg-plus'; }
  const chrome = env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  checks.chrome = await fs.access(chrome).then(() => chrome, () => 'not found; set CHROME_EXECUTABLE or install Google Chrome');
  checks.jevKeyConfigured = Boolean(env.TYPESAFE_API_KEY);
  const probes = await Promise.allSettled(['www.bandai-tcg-plus.com', 'registry.npmjs.org', 'api.typesafe.ai'].map(async host => {
    await lookup(host); return host;
  }));
  checks.dns = Object.fromEntries(probes.map((r, i) => [ ['www.bandai-tcg-plus.com', 'registry.npmjs.org', 'api.typesafe.ai'][i], r.status === 'fulfilled' ? 'ok' : r.reason.code || 'failed' ]));
  console.log(JSON.stringify(checks, null, 2));
  if (!checks.nodeSupported || checks.playwright.startsWith('missing') || Object.values(checks.dns).some(v => v !== 'ok')) process.exitCode = 1;
}

async function inspectPage(page) {
  const state = await page.evaluate(() => {
    const visible = el => Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
    const selects = Array.from(document.querySelectorAll('select')).filter(visible).map((el, index) => ({
      index, id: el.id, name: el.name, value: el.value, disabled: el.disabled,
      label: Array.from(el.labels || []).map(x => x.innerText).join(' '),
      options: Array.from(el.options).map(o => ({ text: o.text, value: o.value, selected: o.selected, disabled: o.disabled }))
    }));
    return {
      url: location.href, title: document.title, text: document.body?.innerText.slice(0, 40000) || '',
      selects,
      buttons: Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible).slice(0, 100).map(el => ({ text: el.innerText || el.getAttribute('aria-label'), disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' })),
      checkboxes: Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(visible).map(el => ({ id: el.id, checked: el.checked, label: Array.from(el.labels || []).map(x => x.innerText).join(' ') })),
      comboboxes: Array.from(document.querySelectorAll('[role="combobox"]')).filter(visible).map(el => ({ label: el.getAttribute('aria-label'), text: el.innerText })),
      links: Array.from(document.querySelectorAll('a[href]')).filter(visible).slice(0, 250).map(el => ({ text: el.innerText, url: el.href }))
    };
  });
  state.url = safeUrl(state.url);
  state.links = state.links.map(link => ({ text: redactText(link.text), url: safeUrl(link.url) }));
  return redact(state);
}

async function run(options, env) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Use Node.js 20 or newer (current: ' + process.version + '). Run npm run doctor for environment checks.');
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { throw new Error('Playwright is not installed. Run npm install in tools/event-collectors/tcg-plus.'); }

  const out = path.join(HERE, 'out', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  await fs.mkdir(PROFILE, { recursive: true, mode: 0o700 });
  const writeJson = (name, value) => fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  const log = (name, value) => fs.appendFile(path.join(out, name), JSON.stringify(value) + '\n', { mode: 0o600 });
  const context = await chromium.launchPersistentContext(PROFILE, {
    ...(env.CHROME_EXECUTABLE ? { executablePath: env.CHROME_EXECUTABLE } : { channel: 'chrome' }),
    headless: options.headless, locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
    viewport: { width: 1440, height: 1000 }, acceptDownloads: false
  });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(30000);
  let page = context.pages()[0] || await context.newPage();
  let sequence = 0;
  let closed = false;
  const network = [];
  const pending = new Set();
  const attached = new WeakSet();
  const track = promise => {
    pending.add(promise);
    promise.catch(() => {}).finally(() => pending.delete(promise));
  };
  async function capture(label = 'snapshot') {
    if (page.isClosed()) throw new Error('Active tab is closed. Open or focus a TCG+ tab.');
    const number = ++sequence;
    const state = await inspectPage(page);
    await writeJson(`${number}-${label}.json`, state);
    await page.screenshot({ path: path.join(out, `${number}-${label}.png`), fullPage: false });
    console.log(`Saved ${number}-${label}.json/.png; ${state.url}`);
    if (state.selects.length) console.log(JSON.stringify(state.selects, null, 2));
    console.log(`Buttons: ${state.buttons.map(b => `${b.text || '(unlabelled)'}${b.disabled ? ' [disabled]' : ''}`).join(' | ')}`);
    return state;
  }
  const attach = tab => {
    if (attached.has(tab)) return;
    attached.add(tab);
    tab.on('domcontentloaded', () => { if (isTcgUrl(tab.url())) page = tab; });
    tab.on('pageerror', error => track(log('errors.ndjson', { kind: 'pageerror', message: redactText(error.message) })));
    tab.on('requestfailed', req => track(log('errors.ndjson', { kind: 'requestfailed', url: safeUrl(req.url()), error: redactText(req.failure()?.errorText || '') })));
    tab.on('response', response => {
      if (!['xhr', 'fetch'].includes(response.request().resourceType())) return;
      const record = { at: new Date().toISOString(), method: response.request().method(), url: safeUrl(response.url()), status: response.status() };
      network.push(record);
      if (network.length > 1000) network.shift();
      track((async () => {
        const headers = response.headers();
        const contentType = headers['content-type'] || '';
        if (isTcgUrl(response.url()) && /json/i.test(contentType)) {
          const size = Number(headers['content-length']);
          if (size > 2_000_000) record.json = 'skipped: content-length exceeds 2 MB';
          else {
            try {
              const body = await response.body();
              if (body.length > 2_000_000) record.json = 'skipped: body exceeds 2 MB';
              else {
                const value = JSON.parse(body.toString('utf8'));
                record.shape = jsonShape(value);
                if (options.saveJson) {
                  record.sample_file = `response-${++sequence}.json`;
                  await writeJson(record.sample_file, redact(value));
                }
              }
            } catch { record.json = 'unavailable or non-JSON'; }
          }
        }
        await log('network.ndjson', record);
      })());
    });
  };
  context.pages().forEach(attach);
  context.on('page', attach);
  let rl;
  let stopControl;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await stopControl?.();
    rl?.close();
    await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => setTimeout(resolve, 2000))]);
    await context.close().catch(() => {});
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  context.once('close', () => { closed = true; void stopControl?.(); rl?.close(); });
  console.log(`Profile: ${PROFILE}\nObservations: ${out}`);
  try {
    try { await page.goto(options.url, { waitUntil: 'domcontentloaded' }); }
    catch (error) {
      console.error('Navigation failed: ' + redactText(error.message));
      await writeJson('navigation-error.json', { url: safeUrl(options.url), error: redactText(error.message) });
      if (options.once) throw new Error('Initial navigation failed; see navigation-error.json.');
    }
    await capture('initial');
    if (options.once) return;
    if (options.control) {
      stopControl = await startControl(async (command, args) => {
        if (command === 'status') return { url: safeUrl(page.url()), responses: network.length };
        if (command === 'snapshot') return inspectPage(page);
        if (command === 'network') return network.slice(-100);
        if (command === 'goto') {
          if (!isTcgUrl(args.url)) throw new Error('goto accepts HTTPS TCG+ URLs only.');
          await page.goto(args.url, { waitUntil: 'domcontentloaded' });
          return inspectPage(page);
        }
        if (command === 'reload') {
          await page.reload({ waitUntil: 'domcontentloaded' });
          return inspectPage(page);
        }
        if (command === 'select') {
          if (!Number.isInteger(args.index) || args.index < 0 || typeof args.value !== 'string') throw new Error('select needs a nonnegative index and an observed option value.');
          await page.locator('select:visible').nth(args.index).selectOption({ value: args.value });
          return inspectPage(page);
        }
        throw new Error('Allowed control commands: status, snapshot, network, goto, reload, select.');
      });
      console.log('Local control ready: node tools/event-collectors/tcg-plus/control.mjs status (from repository root).');
    }
    console.log(HELP);
    rl = createInterface({ input: process.stdin, output: process.stdout });
    while (!closed) {
      let line;
      try { line = (await rl.question('tcg+> ')).trim(); }
      catch { break; }
      if (!line) continue;
      const [command, ...parts] = line.split(/\s+/);
      try {
        if (command === 'quit' || command === 'exit') { await capture('final'); break; }
        if (command === 'help') console.log(HELP);
        else if (command === 'snapshot') await capture();
        else if (command === 'status') console.log(`${safeUrl(page.url())} | ${network.length} recent fetch/XHR responses`);
        else if (command === 'network') console.log(JSON.stringify(network.slice(-15), null, 2));
        else if (command === 'goto') {
          if (!isTcgUrl(parts.join(' '))) throw new Error('goto accepts HTTPS TCG+ URLs only.');
          await page.goto(parts.join(' '), { waitUntil: 'domcontentloaded' });
          await capture();
        } else if (command === 'reload') {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await capture();
        } else if (command === 'select') {
          if (!/^\d+$/.test(parts[0] || '') || parts.length < 2) throw new Error('Usage: select N VALUE (use observed snapshot options).');
          const selects = page.locator('select:visible');
          await selects.nth(Number(parts[0])).selectOption({ value: parts.slice(1).join(' ') });
          await capture();
        } else if (command === 'jev') {
          const state = await capture('before-jev');
          const result = await classifyPage(state, { key: env.TYPESAFE_API_KEY, model: env.TYPESAFE_MODEL });
          await writeJson(`jev-${++sequence}.json`, redact(result));
          console.log(JSON.stringify(result, null, 2));
        } else console.log('Unknown command. Type help.');
      } catch (error) { console.error(redactText(error.message)); }
    }
  } finally { await shutdown(); }
}

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) console.log(HELP);
  else {
    const env = await settings();
    if (options.doctor) await doctor(env);
    else await run(options, env);
  }
} catch (error) {
  console.error(redactText(error.message));
  process.exitCode = 1;
}
