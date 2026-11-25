// The game registry (data/games.json, contracts/games.md): schema, row rules, and agreement with the hand-written D1
// migrations and the event contracts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { GAMES } from '../src/constants';
import { LANDING_GAMES } from '../src/landing';
import { CONTRACTS_DIR, GAME_BITS, GAME_CODES, REPO_DIR } from '../scripts/lib/importer.mjs';
import { voiceGames } from '../scripts/lib/voices.mjs';

type Row = {
  code: string; slug: string | null; hub: boolean; label: string; official: string | null; short: string | null; chip: string | null;
  title_alt: string | null; aliases: string[]; icon: string | null; colour: { slot: number | null; light: string; dark: string } | null;
  official_url: string | null; sources: { releases: string[]; events: { bit: number; sort: number } | null; voices: boolean };
};
const REG: Row[] = JSON.parse(readFileSync(join(REPO_DIR, 'data/games.json'), 'utf8'));
const EV = REG.filter((g) => g.sources.events).sort((a, b) => a.sources.events!.sort - b.sources.events!.sort);
const json = (p: string) => JSON.parse(readFileSync(join(CONTRACTS_DIR, p), 'utf8'));
const dupes = (xs: unknown[]) => xs.filter((x, i) => x != null && xs.indexOf(x) !== i);

/** Every `INSERT INTO games (code, name, slug, sort_order, bit)` row of api/migrations/*.sql, in file order. */
function migrationGames() {
  const dir = join(REPO_DIR, 'api/migrations');
  const rows: { code: string; name: string; slug: string; sort: number; bit: number; file: string }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    for (const m of sql.matchAll(/INSERT INTO games \(([^)]*)\) VALUES([\s\S]*?);/g)) {
      expect(m[1].replace(/\s/g, ''), file).toBe('code,name,slug,sort_order,bit');
      for (const r of m[2].matchAll(/\(\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*(\d+),\s*(\d+)\s*\)/g)) {
        rows.push({ code: r[1], name: r[2].replaceAll("''", "'"), slug: r[3], sort: +r[4], bit: +r[5], file });
      }
    }
  }
  return rows;
}

describe('game registry', () => {
  it('matches contracts/games.schema.json', () => {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(json('games.schema.json'));
    expect(validate(REG) ? [] : validate.errors).toEqual([]);
  });

  it('keeps its keys unique', () => {
    expect(dupes(REG.map((g) => g.code))).toEqual([]);
    expect(dupes(REG.map((g) => g.slug))).toEqual([]);
    expect(dupes(REG.map((g) => g.label))).toEqual([]);
    expect(dupes(REG.flatMap((g) => g.sources.releases))).toEqual([]);
    expect(dupes(REG.map((g) => g.sources.events?.bit))).toEqual([]);
    expect(dupes(REG.map((g) => g.sources.events?.sort))).toEqual([]);
    expect(dupes(REG.map((g) => g.colour?.slot))).toEqual([]);
  });

  it('follows the row rules', () => {
    const slugs = new Set(REG.map((g) => g.slug));
    const reserved = new Set(['releases', 'events', 'voices', 'item', 'privacy', 'feedback', 'api', 'fonts', 'sitemap.xml', 'robots.txt',
      ...readdirSync(join(REPO_DIR, 'public'))]);
    for (const g of REG) {
      const ev = g.sources.events;
      if (ev) expect(ev.bit & (ev.bit - 1), g.code).toBe(0);
      const need = [...(g.hub ? ['slug', 'short', 'title_alt', 'official'] : []), ...(ev ? ['slug', 'official', 'short', 'chip', 'colour'] : []),
        ...(g.sources.voices ? ['chip', 'colour'] : [])] as (keyof Row)[];
      for (const k of need) expect(g[k], `${g.code}.${k}`).toBeTruthy();
      expect(g.sources.releases, g.code).toContain(g.label);
      for (const p of [g.slug, g.code.toLowerCase()]) {
        if (p == null) continue;
        expect(reserved.has(p) || /^\d{4}-\d{2}$/.test(p), `${g.code}: ${p} is a built path`).toBe(false);
      }
      if (g.code.toLowerCase() !== g.slug) expect(slugs.has(g.code.toLowerCase()), `${g.code}: lowercased code is a slug`).toBe(false);
      if (g.icon && /\.(png|svg)$/.test(g.icon)) expect(existsSync(join(REPO_DIR, 'public/gi', g.icon)), g.icon).toBe(true);
    }
  });

  it('equals the games rows the migrations insert', () => {
    const rows = migrationGames();
    expect(dupes(rows.map((r) => r.code))).toEqual([]);
    expect(rows.map((r) => r.code).sort()).toEqual(EV.map((g) => g.code).sort());
    for (const r of rows) {
      const g = REG.find((x) => x.code === r.code)!;
      expect({ code: r.code, name: r.name, slug: r.slug, sort: r.sort, bit: r.bit }, r.file)
        .toEqual({ code: g.code, name: g.official, slug: g.slug, sort: g.sources.events!.sort, bit: g.sources.events!.bit });
    }
  });

  it('is the events game list of the contracts, Worker and importer', () => {
    const codes = EV.map((g) => g.code);
    expect(json('event.schema.json').definitions.gameCode.enum).toEqual(codes);
    expect(json('run.schema.json').properties.game_code.enum).toEqual(codes);
    expect(GAMES.map((g) => g.code)).toEqual(codes);
    expect(GAME_CODES).toEqual(codes);
    expect(GAME_BITS).toEqual(Object.fromEntries(EV.map((g) => [g.code, g.sources.events!.bit])));
    expect(Object.keys(LANDING_GAMES)).toEqual(codes);
  });

  it('gives the voices importer the events games first, then the others', () => {
    expect(voiceGames()).toEqual([...EV, ...REG.filter((g) => !g.sources.events)].filter((g) => g.sources.voices).map((g) => g.code));
    expect(voiceGames()).toEqual(['OPCG', 'UATCG', 'CONAN', 'PTCG', 'GCG', 'DBFW', 'BS', 'DCG', 'WS', 'VG', 'SVE', 'HOCG', 'LLOCG', 'MTG', 'YGO', 'DM']);
  });
});
