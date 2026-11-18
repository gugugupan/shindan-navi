// Month split + ajv validation against contracts/; throws before anything is written.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { containsContact } from './normalize.mjs';

// Free-text fields that must never carry contact details into data/.
const TEXT_FIELDS = ['name', 'format_text', 'eligibility_text', 'fee_text'];

export function makeValidators(repoRoot) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const load = (f) => JSON.parse(readFileSync(join(repoRoot, 'contracts', f), 'utf8'));
  return { events: ajv.compile(load('event.schema.json')), run: ajv.compile(load('run.schema.json')) };
}

export function buildOutputs(events, run, validators) {
  const byMonth = {};
  for (const e of events) (byMonth[`${e.starts_on.slice(0, 7)}.json`] ??= []).push(e);
  for (const e of events) {
    const leaked = [...TEXT_FIELDS.map((k) => e[k]), e.venue?.name].find((v) => v && containsContact(v));
    if (leaked !== undefined) throw new Error(`${e.id}: contact-like text in output`);
  }
  for (const [name, list] of Object.entries(byMonth)) {
    if (!validators.events(list)) {
      throw new Error(`${name} fails event.schema.json: ${JSON.stringify(validators.events.errors.slice(0, 5))}`);
    }
  }
  if (!validators.run(run)) throw new Error(`_run.json fails run.schema.json: ${JSON.stringify(validators.run.errors)}`);
  return { ...byMonth, '_run.json': run };
}
