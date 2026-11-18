import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CONTROL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.control');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = async file => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
};

export async function prepareControl(dir = CONTROL_DIR) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of ['server.json', 'request.json', 'response.json']) {
    try { await fs.writeFile(path.join(dir, name), '{}', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

export async function startControl(dispatch, dir = CONTROL_DIR) {
  await prepareControl(dir);
  const serverId = randomUUID();
  let busy = false;
  let stopped = false;
  let lastId;
  let failure;
  const metadata = () => fs.writeFile(path.join(dir, 'server.json'), JSON.stringify({ serverId, heartbeat: Date.now(), running: !stopped, error: failure }));
  await metadata();
  const tick = async () => {
    if (stopped) return;
    try {
      await metadata();
      if (busy) return;
      busy = true;
      try {
        const request = await readJson(path.join(dir, 'request.json'));
        if (!request?.id || request.serverId !== serverId || request.id === lastId) return;
        lastId = request.id;
        let response;
        try {
          const result = await dispatch(request.command, request.args || {});
          response = { id: request.id, ok: true, result };
        } catch (error) {
          response = { id: request.id, ok: false, error: error.message };
        }
        await fs.writeFile(path.join(dir, 'response.json'), JSON.stringify(response));
      } finally { busy = false; }
    } catch (error) {
      failure = error.code || 'control_io_error';
      console.error('Local control channel error: ' + failure);
      clearInterval(timer);
    }
  };
  const timer = setInterval(() => { void tick(); }, 500);
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await metadata();
  };
}

export async function sendControl(command, args = {}, { dir = CONTROL_DIR, timeout = 40000 } = {}) {
  const server = await readJson(path.join(dir, 'server.json'));
  if (!server?.running || server.error || Date.now() - server.heartbeat > 10000) throw new Error('No live control server. Restart the probe with --control.');
  const lock = path.join(dir, 'client.lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another control command is in progress; do not submit duplicates.');
    throw error;
  }
  try {
    const request = { serverId: server.serverId, id: randomUUID(), command, args };
    await fs.writeFile(path.join(dir, 'request.json'), JSON.stringify(request));
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const response = await readJson(path.join(dir, 'response.json'));
      if (response?.id === request.id) {
        if (!response.ok) throw new Error(response.error);
        return response.result;
      }
      await sleep(100);
    }
    throw new Error('Control command timed out; it may still be executing. Inspect browser state before issuing another action.');
  } finally { await fs.rmdir(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...parts] = process.argv.slice(2);
    if (command === '--init') {
      await prepareControl();
      console.log('Local control directory prepared.');
    } else {
      const args = command === 'goto' ? { url: parts.join(' ') } : command === 'select' ? { index: Number(parts[0]), value: parts.slice(1).join(' ') } : {};
      console.log(JSON.stringify(await sendControl(command, args), null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
