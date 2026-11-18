import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserFetch } from './browser-transport.mjs';
import { collectCompetitions, eventListUrl, parseScrapeOptions, resolveGameTitle, runScrape } from './scrape.mjs';
import { requestJson } from './trial.mjs';
import { redactText } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function splitBrowserArgs(args, env = process.env) {
  const rest = [];
  let headless = false;
  let profile = env.TCG_PLUS_PROFILE || path.join(HERE, '.session/chrome');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--headless') headless = true;
    else if (args[i] === '--profile') {
      profile = args[++i];
      if (!profile) throw new Error('--profile needs a directory.');
    } else rest.push(args[i]);
  }
  return { headless, profile: path.resolve(profile), rest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { headless, profile, rest } = splitBrowserArgs(process.argv.slice(2));
    const options = parseScrapeOptions(rest);
    if (options.help) {
      console.log('TCG+ Japan event collector using normal Chrome requests.\n[--game OPCG|UATCG|CONAN] [--profile DIR | TCG_PLUS_PROFILE=DIR] [--headless] [--page-size 20|40|60|80|100] [--from YYYY-MM-DD] [--until YYYY-MM-DD]\nDefaults to today in Asia/Tokyo. No login, clicks, submissions or database import.');
    } else {
      if (!options.from) {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value]));
        options.from = `${parts.year}-${parts.month}-${parts.day}`;
      }
      let context;
      try {
        const result = await runScrape(options, { transport: 'chrome', collector: async (criteria, dependencies) => {
          // Resolve the title before opening the shared profile so a wrong game never touches the browser.
          const master = await requestJson(new URL('https://api.bandai-tcg-plus.com/api/masterdata'), fetch, []);
          const game = resolveGameTitle(master, criteria.game, criteria.gameTitleId);
          criteria = { ...criteria, gameTitleId: Number(game.id) };
          const { chromium } = await import('playwright-core');
          context = await chromium.launchPersistentContext(profile, {
            ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' }),
            headless, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', acceptDownloads: false
          });
          const page = context.pages()[0] || await context.newPage();
          page.on('response', response => {
            if (new URL(response.url()).pathname === '/api/user/event/list') console.log(JSON.stringify({ stage: 'browser_list_response', status: response.status() }));
          });
          const query = eventListUrl(criteria, 0).search;
          await Promise.all([
            page.waitForResponse(response => new URL(response.url()).pathname === '/api/user/event/list' && response.status() === 200, { timeout: 45000 }),
            page.goto('https://www.bandai-tcg-plus.com/event' + query, { waitUntil: 'domcontentloaded', timeout: 45000 })
          ]);
          const fetchInBrowser = browserFetch(page);
          return collectCompetitions(criteria, { ...dependencies, fetchImpl: (url, requestOptions) =>
            new URL(url).pathname === '/api/masterdata' ? fetch(url, requestOptions) : fetchInBrowser(url, requestOptions)
          });
        } });
        process.exitCode = result.exitCode;
      } finally { await context?.close(); }
    }
  } catch (error) { console.error(redactText(error.message)); process.exitCode = 1; }
}
