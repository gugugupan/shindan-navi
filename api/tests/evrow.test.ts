import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renderer, type Ev, type Group } from '../src/evrow';
import { hydrate, LANDING_GAMES } from '../src/landing';
import { GAMES } from '../src/constants';
import { landingEvent, locOf, REPO_DIR } from '../scripts/lib/importer.mjs';
import { asApi, conflicting, sampleEvents, synthetic } from './helpers';

const read = (p: string) => readFileSync(join(REPO_DIR, p), 'utf8');

/** window.snEv from src/evrow.html, run as the browser would (no DOM needed to render). */
function pageRenderer() {
  const script = /<script>([\s\S]*?)<\/script>/.exec(read('src/evrow.html'))![1];
  const ctx: Record<string, any> = { window: {}, document: { addEventListener() {} }, Intl, Date, Set, Map, Number, String, Array, Object, RegExp, JSON, Math };
  runInNewContext(script, ctx);
  return ctx.window.snEv;
}

const icon = (n: string) => {
  const g = Object.values(LANDING_GAMES).find((x) => x.label === n);
  const v = g ? g.icon : [...String(n || '?')][0].toUpperCase();
  return /\.(png|svg)$/.test(v) ? `<img class="gi" src="/gi/${v}" width="16" height="16" alt="" aria-hidden="true">` : `<span class="gi" aria-hidden="true">${v}</span>`;
};
const games = Object.fromEntries(Object.entries(LANDING_GAMES).map(([k, g]) => [k, { name: g.label, c: g.c, cd: g.cd }]));

// Real-looking shapes: the contract fixture, synthetic rows (cancelled / postponed / fees / registration states),
// shared venue ids, month-marker names, a group of identical events, a shared (multi-game) event.
function fixtures(): Ev[] {
  const base = [...sampleEvents(), ...synthetic(60), ...conflicting(12)].map(asApi);
  const day = base[0].starts_on;
  const same = synthetic(5, 900).map((e, i) => asApi({ ...e, starts_on: day, name: '【SYNTHETIC】スタンダードバトル（11月開催）', game_code: 'OPCG',
    group: { ...e.group, event_type_code: 'standard_battle' }, registration_method: i % 2 ? 'first_come' : 'lottery', event_status: 'scheduled' }));
  const shared = { ...asApi(synthetic(1, 950)[0]), game_codes: ['OPCG', 'UATCG'], registration_status: 'not_open', registration_opens_at: '2026-11-20T12:00:00+09:00' };
  return [...base, ...same, shared];
}

describe('evrow.ts mirrors src/evrow.html', () => {
  it('renders identical rows', () => {
    const page = pageRenderer();
    page.init({ gi: icon, games });
    const ts = renderer(icon, games);
    for (const e of fixtures()) {
      for (const o of [{}, { col: e.game_code, pref: 'JP-13' }, { compact: true }, { member: true }, { compact: true, started: true }]) {
        expect(ts.row(e, o)).toBe(page.row(e, o));
      }
      expect(ts.name(e)).toBe(page.name(e));
    }
  });

  it('groups and renders groups identically', () => {
    const page = pageRenderer();
    page.init({ gi: icon, games });
    const ts = renderer(icon, games);
    const byDay = new Map<string, Ev[]>();
    for (const e of fixtures()) byDay.set(e.starts_on, [...(byDay.get(e.starts_on) ?? []), e]);
    let groups = 0;
    for (const [day, rows] of byDay) {
      const a = ts.group(rows), b = page.group(rows);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      for (const [i, x] of a.entries()) {
        if (!('rows' in x)) continue;
        groups++;
        for (const o of [{ day, col: 'OPCG', pref: 'JP-13' }, { day, more: true }]) expect(ts.grp(x as Group, o)).toBe(page.grp(b[i], o));
      }
    }
    expect(groups).toBeGreaterThan(0);
  });
});

describe('landing rows keep what the rows show', () => {
  it('renders a stored (compact, hydrated) event like the API event', () => {
    const ts = renderer(icon, games);
    let n = 0;
    for (const e of fixtures()) {
      const loc = locOf(e);
      if (!loc) continue;
      const back = hydrate(landingEvent(e, e.game_codes, loc), e.game_code, loc);
      for (const o of [{ col: e.game_code, pref: loc }, {}]) expect(ts.row(back, o)).toBe(ts.row(e, o));
      n++;
    }
    expect(n).toBeGreaterThan(50);
  });
});

describe('landing registry matches the pages', () => {
  it('uses the /events/ palette and display names', () => {
    const block = read('src/events.html').split('const GAMES = [')[1].split('];')[0];
    const rows = [...block.matchAll(/\{code:'(\w+)', name:'([^']+)', c:'(#[0-9a-f]{6})', cd:'(#[0-9a-f]{6})', bit:(\d+)\}/g)];
    expect(rows.map((m) => m[1])).toEqual(GAMES.map((g) => g.code));
    for (const [, code, label, c, cd] of rows) expect(LANDING_GAMES[code]).toMatchObject({ label, c, cd });
  });

  it('uses the GAME_ICON icons and the build.py title pages', () => {
    const build = read('scripts/build.py');
    const icons = Object.fromEntries([...build.split('GAME_ICON={')[1].split('}')[0].matchAll(/'([^']+)':'([^']+)'/g)].map((m) => [m[1], m[2]]));
    const titles = new Set([...build.split('GAMES=[')[1].split(']\n')[0].matchAll(/\('([a-z]+)','/g)].map((m) => m[1]));
    for (const g of GAMES) {
      expect(LANDING_GAMES[g.code].icon).toBe(icons[LANDING_GAMES[g.code].label]);
      expect(LANDING_GAMES[g.code].releases).toBe(titles.has(g.slug));
    }
  });
});
