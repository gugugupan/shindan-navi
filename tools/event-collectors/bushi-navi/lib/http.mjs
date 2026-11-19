// Sequential, rate-limited GETs against the public Bushi Navi user API.

export const API_ORIGIN = 'https://api-user.bushi-navi.com';
export const USER_AGENT = 'Mozilla/5.0 (compatible; shindan-navi-event-collector/0.1)';
export const MIN_DELAY_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * fetchJson(path) → parsed body. Requests are at least `delayMs` apart (start to start). 429, 5xx, timeouts and
 * network errors are retried `retries` times with growing waits; other statuses throw at once.
 */
export function makeTransport({ delayMs = 1100, retries = 3, maxRequests = 2000, timeoutMs = 30000, fetchImpl = fetch, wait = sleep, now = Date.now } = {}) {
  const gap = Math.max(MIN_DELAY_MS, delayMs);
  let count = 0;
  let last = -Infinity;

  async function once(path) {
    if (count >= maxRequests) throw new Error(`request budget ${maxRequests} exhausted`);
    const pause = last + gap - now();
    if (pause > 0) await wait(pause);
    last = now();
    count += 1;
    const res = await fetchImpl(`${API_ORIGIN}${path}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'X-Accept-Version': 'v1' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    const body = await res.text();
    if (res.status !== 200) throw new HttpError(`GET ${path}: HTTP ${res.status} ${body.slice(0, 200)}`, res.status);
    try {
      return JSON.parse(body);
    } catch {
      throw new HttpError(`GET ${path}: body is not JSON`, res.status);
    }
  }

  async function fetchJson(path) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await once(path);
      } catch (err) {
        const retryable = !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
        if (!retryable || attempt >= retries || /budget/.test(err.message)) throw err;
        await wait(gap * 5 * (attempt + 1));
      }
    }
  }

  return { fetchJson, requests: () => count };
}
