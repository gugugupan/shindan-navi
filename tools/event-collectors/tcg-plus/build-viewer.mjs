import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEvent } from './viewer/model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const input = path.resolve(process.argv[2] || path.join(here, 'out/stopped-partial-2026-11-17T17-09-27.967Z'));
const out = path.join(here, 'out/competition-viewer');
const report = JSON.parse(await fs.readFile(path.join(input, 'report.json'), 'utf8'));
const filename = report.data_file;
if (!['competitions.partial.json', 'competitions.json'].includes(filename)) throw new Error('Report must reference a known competition data file.');
const records = JSON.parse(await fs.readFile(path.join(input, filename), 'utf8'));
if (!Array.isArray(records) || !records.length) throw new Error('Expected a nonempty competition array.');
const events = records.map(normalizeEvent).sort((a, b) =>
  (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '99:99').localeCompare(b.time || '99:99') || a.id.localeCompare(b.id));
if (new Set(events.map(event => event.id)).size !== events.length) throw new Error('Duplicate event IDs.');
const dates = events.map(event => event.date).filter(Boolean).sort();
const declaredTotal = report.coverage?.source_total ?? report.source_declared_totals?.[0] ?? null;
const data = {
  meta: {
    count: events.length, declaredTotal, complete: report.coverage?.complete_for_source_total === true,
    observedAt: report.recovered_at || report.finished_at || null,
    firstDate: dates[0], lastDate: dates.at(-1),
    scope: 'ONE PIECE · 日本', unknownTimes: events.filter(event => !event.time).length
  }, events
};
const safeJson = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const model = (await fs.readFile(path.join(here, 'viewer/model.mjs'), 'utf8')).replace(/^export /gm, '');
const template = await fs.readFile(path.join(here, 'viewer/index.template.html'), 'utf8');
const html = template.replace('/* VIEWER_MODEL */', () => model).replace('/* VIEWER_DATA */', () => safeJson);
await fs.mkdir(out, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(out, 'index.html'), html, { mode: 0o600 });
console.log(JSON.stringify({ file: path.join(out, 'index.html'), ...data.meta, bytes: Buffer.byteLength(html) }, null, 2));
