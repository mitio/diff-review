import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.ts';

let dir: string;
let servers: Server[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ghr-server-'));
  await mkdir(join(dir, 'dist/assets'), { recursive: true });
  await writeFile(join(dir, 'dist/index.html'), '<html>app</html>');
  await writeFile(join(dir, 'dist/assets/app.js'), 'app()');
  await writeFile(join(dir, 'secret.txt'), 'secret');
});
afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  servers = [];
  await rm(dir, { recursive: true, force: true });
});
async function start(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  const app = createApp({ port: 7777, distDir: join(dir, 'dist'), dev: false, getToken: async () => 'token', fetchImpl: vi.fn(async () => new Response('{}')), ...overrides });
  servers.push(app);
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  return (path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path, method: options.method ?? 'GET', headers: { host: '127.0.0.1:7777', ...options.headers } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
const api = { 'x-ghr': '1' };
describe('request guards', () => {
  it('requires an exact trusted host on every path', async () => {
    const get = await start();
    for (const host of ['evil.test', '127.0.0.1', 'localhost:7777.evil', 'LOCALHOST:7777']) {
      expect((await get('/', { headers: { host } })).status).toBe(403);
    }
    expect((await get('/', { headers: { host: 'localhost:7777' } })).status).toBe(200);
  });
  it('requires x-ghr and rejects foreign origins without CORS headers', async () => {
    const get = await start();
    expect((await get('/api/rest/repos/o/r/pulls/1')).status).toBe(403);
    const bad = await get('/api/rest/repos/o/r/pulls/1', { headers: { ...api, origin: 'https://evil.test' } });
    expect(bad.status).toBe(403);
    expect(Object.keys(bad.headers).some(name => name.startsWith('access-control-'))).toBe(false);
  });
  it('allows dev origins only in dev', async () => {
    for (const dev of [false, true]) {
      const get = await start({ dev });
      for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
        expect((await get('/api/rest/repos/o/r/pulls/1', { headers: { ...api, origin } })).status).toBe(dev ? 200 : 403);
      }
      expect((await get('/api/rest/repos/o/r/pulls/1', { headers: { ...api, origin: 'http://localhost:7777' } })).status).toBe(200);
    }
  });
  it('rejects OPTIONS everywhere', async () => {
    const get = await start({ dev: true });
    for (const path of ['/', '/api/graphql']) expect((await get(path, { method: 'OPTIONS', headers: api })).status).toBe(403);
  });
});
it('allowlists exact REST paths and forwards headers, status, body and links', async () => {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{"ok":true}', { status: 202, headers: { link: '<next>; rel="next"' } }));
  const get = await start({ fetchImpl });
  for (const path of ['repos/o/r/pulls/1', 'repos/o/r/pulls/1/files?per_page=100&page=2', 'repos/a.b/r-name/compare/abcdef0...0123456?per_page=1']) {
    const result = await get(`/api/rest/${path}`, { headers: api });
    expect(result.status).toBe(202);
    expect(result.body).toBe('{"ok":true}');
    expect(result.headers.link).toBe('<next>; rel="next"');
  }
  expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/o/r/pulls/1');
  const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
  expect(headers.get('accept')).toBe('application/vnd.github+json');
  expect(headers.get('x-github-api-version')).toBe('2022-11-28');
  expect(headers.get('user-agent')).toBe('gh-review');
  for (const path of ['repos/o/r/issues/1', 'repos/o/r/pulls/1/comments', 'repos/o/r/pulls/1?x=%2f', 'repos/o/r/compare/main...head', 'repos/o/r/pulls/1/../2']) {
    expect((await get(`/api/rest/${path}`, { headers: api })).status).toBe(400);
  }
  expect((await get('/api/rest/repos/o/r/pulls/1', { method: 'POST', headers: api })).status).toBe(405);
});
it('refreshes cached token once after 401 and preserves GraphQL JSON', async () => {
  const getToken = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new');
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    seen.push(new Headers(init?.headers).get('authorization')!);
    expect(new Headers(init?.headers).get('user-agent')).toBe('gh-review');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ query: '{viewer{login}}' });
    return new Response('{"data":{}}', { status: seen.length === 1 ? 401 : 200 });
  };
  const get = await start({ getToken, fetchImpl });
  const options = { method: 'POST', headers: api, body: '{"query":"{viewer{login}}"}' };
  expect((await get('/api/graphql', options)).status).toBe(200);
  expect((await get('/api/graphql', options)).status).toBe(200);
  expect(seen).toEqual(['bearer old', 'bearer new', 'bearer new']);
  expect(getToken).toHaveBeenCalledTimes(2);
});
it('retries a 401 only once', async () => {
  const fetchImpl = vi.fn(async () => new Response('{"message":"Bad credentials"}', { status: 401 }));
  const get = await start({ fetchImpl });
  expect((await get('/api/rest/repos/o/r/pulls/1', { headers: api })).status).toBe(401);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it('rejects invalid or oversized GraphQL JSON', async () => {
  const get = await start();
  expect((await get('/api/graphql', { method: 'POST', headers: api, body: '{' })).status).toBe(400);
  expect((await get('/api/graphql', { method: 'POST', headers: api, body: JSON.stringify({ query: 'x'.repeat(1024 * 1024) }) })).status).toBe(413);
});
it('blocks traversal and symlinks outside dist', async () => {
  await symlink(join(dir, 'secret.txt'), join(dir, 'dist/leak.txt'));
  const get = await start();
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/leak.txt', '/%5c..%5csecret.txt']) {
    const result = await get(path);
    expect(result.status).toBe(403);
    expect(result.body).not.toContain('secret');
  }
});
it('serves SPA fallback with HTML security and no-cache headers', async () => {
  const get = await start();
  for (const path of ['/', '/o/r/pull/1', '/index.html']) {
    const result = await get(path);
    expect(result.status).toBe(200);
    expect(result.body).toBe('<html>app</html>');
    expect(result.headers['content-type']).toContain('text/html');
    expect(result.headers['cache-control']).toBe('no-cache');
    expect(result.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(result.headers['x-frame-options']).toBe('DENY');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['referrer-policy']).toBe('no-referrer');
  }
  expect((await get('/assets/missing.js')).headers['cache-control']).toBe('no-cache');
  const asset = await get('/assets/app.js');
  expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(asset.headers['content-type']).toContain('javascript');
});
it('asks for a build if the SPA entry is absent', async () => {
  await rm(join(dir, 'dist/index.html'));
  const get = await start();
  const result = await get('/any-route');
  expect(result.status).toBe(500);
  expect(result.body).toBe('run npm run build');
});

describe('diff endpoint', () => {
  it('proxies only whole-PR diffs with the diff media type', async () => {
    const fetchImpl = vi.fn(async () => new Response('diff --git a/x b/x'));
    const get = await start({ fetchImpl });
    const ok = await get('/api/diff/repos/o/r/pulls/12', { headers: api });
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('diff --git a/x b/x');
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Accept).toBe('application/vnd.github.diff');
    expect((await get('/api/diff/repos/o/r/pulls/12/files', { headers: api })).status).toBe(400);
    expect((await get('/api/diff/repos/o/r/issues/12', { headers: api })).status).toBe(400);
    expect((await get('/api/diff/repos/o/r/pulls/12')).status).toBe(403);
  });
});
