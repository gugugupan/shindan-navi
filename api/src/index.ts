import { BadRequest, listEvents } from './events';
import { getMeta } from './meta';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const route = url.pathname === '/api/v1/events' ? 'events' : url.pathname === '/api/v1/events/meta' ? 'meta' : null;
  if (!route) return json({ error: 'not found' }, 404);
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });
  let res: Response;
  try {
    res = json(route === 'events' ? await listEvents(env.DB, url.searchParams) : await getMeta(env.DB));
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: 'internal error' }, 500);
  }
  return request.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env, url);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
