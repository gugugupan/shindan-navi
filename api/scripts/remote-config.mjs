#!/usr/bin/env node
// Writes <repo>/wrangler.remote.json: the root wrangler.jsonc with the real D1 database_id from env
// D1_DATABASE_ID. Used by the deploy workflow and remote imports; the file is git-ignored and the id is
// never printed. No npm dependencies, so CI can run it before any install.
//
//   D1_DATABASE_ID=... node api/scripts/remote-config.mjs [--domain]
//
// --domain adds the shindan-navi.app custom domain. The committed config has no route on purpose: a deploy
// only reaches the version preview URL until the domain is moved explicitly (see README.md, Deploy).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const BASE_CONFIG = join(REPO_DIR, 'wrangler.jsonc');
export const REMOTE_CONFIG = join(REPO_DIR, 'wrangler.remote.json');
export const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';
export const DOMAIN_ROUTE = { pattern: 'shindan-navi.app', custom_domain: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readBaseConfig(path = BASE_CONFIG) {
  const text = readFileSync(path, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  return JSON.parse(text);
}

/** Returns the config with the real id; throws with a readable message when the id is missing or malformed. */
export function remoteConfig(databaseId, { domain = false, base = readBaseConfig() } = {}) {
  const id = (databaseId ?? '').trim();
  if (!id) throw new Error('D1_DATABASE_ID is empty: set the GitHub secret (deploy) or export it locally (remote import)');
  if (!UUID.test(id) || id === PLACEHOLDER_ID) throw new Error('D1_DATABASE_ID is not a D1 database id (expected a UUID)');
  const config = structuredClone(base);
  const dbs = config.d1_databases ?? [];
  if (dbs.length !== 1 || dbs[0].database_id !== PLACEHOLDER_ID) throw new Error('wrangler.jsonc must declare exactly one D1 database with the placeholder id');
  dbs[0].database_id = id;
  delete config.$schema;
  if (config.routes) throw new Error('wrangler.jsonc must not declare routes; the domain is added with --domain');
  if (domain) config.routes = [DOMAIN_ROUTE];
  return config;
}

export function writeRemoteConfig(databaseId, opts = {}, out = REMOTE_CONFIG) {
  writeFileSync(out, JSON.stringify(remoteConfig(databaseId, opts), null, 2) + '\n');
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const domain = process.argv.includes('--domain');
    const out = writeRemoteConfig(process.env.D1_DATABASE_ID, { domain });
    console.log(`remote-config: wrote ${out} (${domain ? `custom domain ${DOMAIN_ROUTE.pattern}` : 'no route: version preview URL only'})`);
  } catch (e) {
    console.error(`remote-config: ${e.message}`);
    process.exit(1);
  }
}
