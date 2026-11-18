export function browserFetch(page) {
  return async (input, options = {}) => {
    const url = new URL(input);
    if (url.origin !== 'https://api.bandai-tcg-plus.com' ||
        !['/api/masterdata', '/api/user/event/list', '/api/user/event/list/params'].includes(url.pathname) ||
        (options.method && options.method !== 'GET') || url.username || url.password) {
      throw new Error('Browser transport only permits public game-directory and event-list GET requests.');
    }
    if (new URL(page.url()).origin !== 'https://www.bandai-tcg-plus.com') throw new Error('Browser must be on the TCG+ website.');
    const result = await page.evaluate(async target => {
      const response = await fetch(target, {
        method: 'GET', credentials: 'omit', redirect: 'error',
        headers: { Accept: 'application/json, text/plain, */*', 'X-Accept-Version': 'v1' },
        signal: AbortSignal.timeout(15000)
      });
      const reader = response.body?.getReader();
      if (!reader) return { status: response.status, body: null };
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) throw new Error('Public API response exceeds 8 MiB.');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const combined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
      return { status: response.status, body: new TextDecoder().decode(combined) };
    }, url.toString());
    return new Response(result.body, { status: result.status });
  };
}
