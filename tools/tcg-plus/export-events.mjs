import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOutputs, loadValidators, writeOutputs } from './normalize.mjs';
import { redactText } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../../data/events');

export function parseExportOptions(args) {
  const options = { dir: null, from: '2026-11-18', until: '2027-02-18', notes: [], dryRun: false, dataDir: DATA };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--from' || arg === '--until') {
      const value = args[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error(`${arg} needs YYYY-MM-DD.`);
      options[arg.slice(2)] = value;
    } else if (arg === '--note') options.notes.push(args[++i] ?? '');
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--data-dir') options.dataDir = path.resolve(args[++i]);
    else if (!options.dir && !arg.startsWith('--')) options.dir = path.resolve(arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.dir) throw new Error('Usage: export-events.mjs <out/events-*> [--from YYYY-MM-DD] [--until YYYY-MM-DD] [--note TEXT]... [--dry-run]');
  if (options.from >= options.until) throw new Error('--from must be before --until.');
  return options;
}

export async function exportEvents(options) {
  const report = JSON.parse(await fs.readFile(path.join(options.dir, 'report.json'), 'utf8'));
  const records = JSON.parse(await fs.readFile(path.join(options.dir, 'competitions.json'), 'utf8'));
  const game = report.query?.game;
  if (!['OPCG', 'UATCG', 'CONAN'].includes(game)) throw new Error('Collection report has no TCG+ game code.');
  const validators = await loadValidators();
  const result = buildOutputs({ records, report, game, window: { from: options.from, until: options.until }, validators, notes: options.notes });
  const target = path.join(options.dataDir, game);
  if (!options.dryRun) await writeOutputs(target, result.files);
  return { ...result, target };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseExportOptions(process.argv.slice(2));
    const { run, files, target } = await exportEvents(options);
    console.log(JSON.stringify({ written: !options.dryRun, target, files: [...files.keys()], record_count: run.record_count, source_total: run.source_total, complete: run.complete }, null, 2));
  } catch (error) { console.error(redactText(error.message)); process.exitCode = 1; }
}
