// 話題カレンダー gate data. The real snapshots live only in D1 and the owner's local copy (contracts/voices.md), so the
// gates run on the made-up snapshots in fixtures/voices/. They are marked sample: true so the importer never loads them
// by accident; snapshots() drops the flag and the note and moves every date by the same number of days so the last
// snapshot falls on --today (the calendar opens on the current month, the home block hides snapshots over 7 days old).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/voices');
const DAY = 864e5;
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The fixture snapshots, oldest first, as files the importer accepts (version, date, window, topics), ending on today. */
export function snapshots(today) {
  const raw = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')));
  const n = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${raw.at(-1).date}T00:00:00Z`)) / DAY);
  const win = (w) => ({ from: shift(w.from, n), to: shift(w.to, n) });
  return raw.map((s) => ({ version: s.version, date: shift(s.date, n), window: win(s.window),
    topics: s.topics.map((t) => ({ ...t, window: win(t.window), first_seen: shift(t.first_seen, n) })) }));
}

/** Writes snapshots(today) as <date>.json into dir (emptied first) for the importer's --data. */
export function writeSnapshots(dir, today) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const s of snapshots(today)) fs.writeFileSync(path.join(dir, `${s.date}.json`), JSON.stringify(s, null, 2) + '\n');
}
