import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  const app = createApp({ port: 7777, distDir: join(dir, 'dist'), dev: false, stateDir: join(dir, 'state'), getToken: async () => 'token', fetchImpl: vi.fn(async () => new Response('{}')), ...overrides });
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
  expect(headers.get('user-agent')).toBe('diff-review');
  for (const path of ['repos/o/r/issues/1', 'repos/o/r/pulls/1/comments', 'repos/o/r/pulls/1?x=%2f', 'repos/o/r/pulls/1/../2']) {
    expect((await get(`/api/rest/${path}`, { headers: api })).status).toBe(400);
  }
  expect((await get('/api/rest/repos/o/r/pulls/1', { method: 'POST', headers: api })).status).toBe(405);
});
it('refreshes cached token once after 401 and preserves GraphQL JSON', async () => {
  const getToken = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new');
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    seen.push(new Headers(init?.headers).get('authorization')!);
    expect(new Headers(init?.headers).get('user-agent')).toBe('diff-review');
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

it('reports its identity and accepts commit and branch compare paths', async () => {
  const get = await start();
  expect(JSON.parse((await get('/api/ping', { headers: api })).body)).toMatchObject({ ok: true, name: 'diff-review' });
  for (const prefix of ['rest', 'diff']) {
    for (const path of ['commits/abcdef0', 'compare/feature/a...release/b']) {
      expect((await get(`/api/${prefix}/repos/o/r/${path}`, { headers: api })).status).toBe(200);
    }
    expect((await get(`/api/${prefix}/repos/o/r/compare/../../x`, { headers: api })).status).toBe(400);
  }
});
it('roundtrips pastes and serializes review versions', async () => {
  const get = await start();
  const call = (path: string, method = 'GET', data?: unknown) => get(path, { method, headers: api, body: data === undefined ? undefined : JSON.stringify(data) });
  const pasted = JSON.parse((await call('/api/paste', 'POST', { diff: 'diff text' })).body);
  expect((await call(`/api/paste/${pasted.id}`)).body).toBe('diff text');
  expect((await call('/api/state?key=k')).status).toBe(404);
  const doc = { ref: { kind: 'paste', id: pasted.id }, title: 'Test', viewed: { x: 'hash' }, threads: [] };
  const results = await Promise.all([call('/api/state?key=k', 'PUT', { doc, baseVersion: 0 }), call('/api/state?key=k', 'PUT', { doc, baseVersion: 0 })]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(JSON.parse((await call('/api/state?key=k', 'PUT', { doc, baseVersion: 1 })).body)).toEqual({ version: 2 });
  expect(JSON.parse((await call('/api/states')).body)).toMatchObject([{ key: 'k', threads: 0, open: 0, viewed: 1 }]);
});

const exec = promisify(execFile);
async function gitRepo() {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'diff-review-git-')));
  await exec('git', ['init', '-b', 'main', repo]);
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args])).stdout.trim();
  return { repo, git };
}
it('diffs staged, untracked, unborn and removed-from-index paths and snapshots blobs', async () => {
  const { repo, git } = await gitRepo();
  try {
    const get = await start();
    const diff = async (range = '') => get(`/api/local/diff?${new URLSearchParams({ repo, range })}`, { headers: api });
    await writeFile(join(repo, 'new file.txt'), 'first\n');
    const unborn = JSON.parse((await diff()).body);
    expect(unborn.baseOid).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    expect(unborn.diff).toContain('diff --git a/new file.txt b/new file.txt');
    expect(unborn.diff).toContain('+++ b/new file.txt');
    await git('add', '.'); await git('commit', '-m', 'Root subject');
    const root = await git('rev-parse', 'HEAD');
    expect(JSON.parse((await diff('HEAD^!')).body)).toMatchObject({ baseOid: unborn.baseOid, headOid: root, title: 'Root subject', author: { name: 'Test', email: 'test@example.com' } });
    await writeFile(join(repo, 'new file.txt'), 'staged\n'); await git('add', '.');
    await writeFile(join(repo, 'binary'), Buffer.from([1, 0, 2]));
    const snapshot = JSON.parse((await diff()).body);
    expect(snapshot.diff).toContain('+staged');
    expect(snapshot.diff).toContain('Binary files /dev/null and b/binary differ');
    await writeFile(join(repo, 'new file.txt'), 'later\n');
    const specs = [{ commit: root, path: 'new file.txt' }, { commit: snapshot.headOid, path: 'new file.txt' }, { commit: snapshot.headOid, path: 'binary' }, { commit: root, path: 'missing' }];
    const blobs = JSON.parse((await get('/api/local/blobs', { method: 'POST', headers: api, body: JSON.stringify({ repo, specs }) })).body);
    expect(blobs[`${root}:new file.txt`].text).toBe('first\n');
    expect(blobs[`${snapshot.headOid}:new file.txt`].text).toBe('staged\n');
    expect(blobs[`${snapshot.headOid}:binary`]).toMatchObject({ binary: true, text: null });
    expect(blobs[`${root}:missing`].missing).toBe(true);
    await git('rm', '--cached', '-f', 'new file.txt');
    expect(JSON.parse((await diff()).body).diff.match(/^diff --git a\/new file.txt b\/new file.txt$/gm)).toHaveLength(1);
    for (const range of ['-HEAD', 'HEAD;id', 'HEAD bad', 'HEAD..-HEAD']) expect((await diff(range)).status).toBe(400);
    await mkdir(join(repo, 'sub'));
    const bad = await get(`/api/local/diff?repo=${encodeURIComponent(join(repo, 'sub'))}`, { headers: api });
    expect(bad.status).toBe(404);
    expect(JSON.parse(bad.body).message).toBe('Not a git repository root');
  } finally { await rm(repo, { recursive: true, force: true }); }
});
it('resolves two-dot, merge-base and first-parent commit ranges', async () => {
  const { repo, git } = await gitRepo();
  try {
    const get = await start();
    const diff = async (range: string) => JSON.parse((await get(`/api/local/diff?${new URLSearchParams({ repo, range })}`, { headers: api })).body);
    await writeFile(join(repo, 'a'), 'base\n'); await git('add', '.'); await git('commit', '-m', 'base');
    const base = await git('rev-parse', 'HEAD');
    await git('checkout', '-b', 'branch');
    await writeFile(join(repo, 'b'), 'branch\n'); await git('add', '.'); await git('commit', '-m', 'branch');
    const branch = await git('rev-parse', 'HEAD');
    expect(await diff('HEAD^!')).toMatchObject({ baseOid: base, headOid: branch });
    await git('checkout', 'main');
    await writeFile(join(repo, 'c'), 'main\n'); await git('add', '.'); await git('commit', '-m', 'main');
    const main = await git('rev-parse', 'HEAD');
    expect(await diff('main..branch')).toMatchObject({ baseOid: main, headOid: branch });
    expect(await diff('main...branch')).toMatchObject({ baseOid: base, mergeBaseOid: base, headOid: branch });
    await git('checkout', 'branch');
    expect(await diff('main...')).toMatchObject({ baseOid: base, headOid: branch });
    expect(await diff('main..')).toMatchObject({ baseOid: main, headOid: branch });
    await git('checkout', 'main');
    await git('merge', '--no-ff', 'branch', '-m', 'merge');
    expect(await diff('HEAD^!')).toMatchObject({ baseOid: main, headOid: await git('rev-parse', 'HEAD'), title: 'merge' });
  } finally { await rm(repo, { recursive: true, force: true }); }
});
it('allows exactly one concurrent write at a given version', async () => {
  const get = await start();
  const doc = { ref: { kind: 'paste', id: 'a'.repeat(64) }, title: 'Concurrent', viewed: {}, threads: [] };
  const put = (baseVersion: number) => get('/api/state?key=concurrent', { method: 'PUT', headers: api, body: JSON.stringify({ doc, baseVersion }) });
  const results = await Promise.all([put(0), put(0)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(JSON.parse(results.find(r => r.status === 409)!.body).doc.version).toBe(1);
  expect(JSON.parse((await put(1)).body)).toEqual({ version: 2 });
});
it('handles unborn HEAD, root commits and untracked paths with spaces or escapes', async () => {
  const { repo, git } = await gitRepo();
  try {
    const get = await start();
    const diff = async (range = '') => {
      const result = await get(`/api/local/diff?${new URLSearchParams({ repo, range })}`, { headers: api });
      expect(result.status).toBe(200);
      return JSON.parse(result.body);
    };
    const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    expect(await diff()).toMatchObject({ baseOid: emptyTree, diff: '', title: 'Uncommitted changes' });
    await writeFile(join(repo, 'staged'), 'staged\n');
    await git('add', '.');
    await mkdir(join(repo, 'a b'));
    const paths = ['a b/file', 'a b/has b/ inside', 'tab\tfile', 'line\nfile'];
    await mkdir(join(repo, 'a b/has b'));
    for (const path of paths) await writeFile(join(repo, path), 'untracked\n');
    const local = await diff();
    expect(local.diff).toContain('+staged');
    expect(local.diff.match(/\+untracked/g)).toHaveLength(4);
    const specs = paths.map(path => ({ commit: local.headOid, path }));
    const blobs = await get('/api/local/blobs', { method: 'POST', headers: api, body: JSON.stringify({ repo, specs }) });
    for (const path of paths) expect(JSON.parse(blobs.body)[`${local.headOid}:${path}`].text).toBe('untracked\n');
    await git('add', '.'); await git('commit', '-m', 'Root subject');
    const root = await diff('HEAD^!');
    expect(root).toMatchObject({ baseOid: emptyTree, mergeBaseOid: emptyTree, title: 'Root subject', author: { name: 'Test', email: 'test@example.com' } });
    expect(root.headOid).toMatch(/^[a-f0-9]{40}$/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
it('enforces route methods, JSON shape and separate body limits', async () => {
  const get = await start();
  for (const [path, method] of [['/api/ping', 'POST'], ['/api/local/diff', 'POST'], ['/api/local/blobs', 'GET'], ['/api/paste', 'GET'], ['/api/state?key=k', 'POST'], ['/api/states', 'PUT']]) {
    const result = await get(path, { method, headers: api });
    expect(result.status).toBe(405);
    expect(JSON.parse(result.body)).toHaveProperty('message');
  }
  for (const [path, method, body] of [['/api/state?key=k', 'PUT', '{}'], ['/api/paste', 'POST', '{'], ['/api/local/blobs', 'POST', '{"specs":null}']]) {
    expect((await get(path, { method, headers: api, body })).status).toBe(400);
  }
  for (const path of ['/api/state?key=k', '/api/local/blobs']) {
    expect((await get(path, { method: path.includes('state') ? 'PUT' : 'POST', headers: api, body: JSON.stringify({ diff: 'x'.repeat(5 * 1024 * 1024) }) })).status).toBe(413);
  }
  expect((await get('/api/paste', { method: 'POST', headers: api, body: JSON.stringify({ diff: 'x'.repeat(6 * 1024 * 1024) }) })).status).toBe(200);
  expect((await get('/api/paste/' + 'f'.repeat(64), { headers: api })).status).toBe(404);
  expect((await get('/api/paste/bad', { headers: api })).status).toBe(400);
  expect((await get('/api/local/diff?repo=relative', { headers: api })).status).toBe(400);
  expect((await get(`/api/local/diff?repo=${encodeURIComponent(dir)}`, { headers: api })).status).toBe(404);
});
it('truncates large blobs and excludes symlinks outside the repository', async () => {
  const { repo, git } = await gitRepo();
  try {
    const get = await start();
    const large = Buffer.alloc(5 * 1024 * 1024 + 1, 'a');
    await writeFile(join(repo, 'large'), large);
    await writeFile(join(repo, 'binary'), Buffer.from([1, 0, 2]));
    await writeFile(join(repo, 'small'), 'base\n');
    await git('add', '.'); await git('commit', '-m', 'base');
    const oid = await git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'large'), Buffer.concat([large, Buffer.from('b')]));
    await writeFile(join(repo, 'untracked-large'), large);
    await symlink(join(dir, 'secret.txt'), join(repo, 'outside'));
    await symlink(join(repo, '.git/config'), join(repo, 'git-config'));
    const local = JSON.parse((await get(`/api/local/diff?repo=${encodeURIComponent(repo)}`, { headers: api })).body);
    expect(local.diff).toContain('Binary files /dev/null and b/untracked-large differ');
    const specs = [
      { commit: oid, path: 'large' }, { commit: oid, path: 'binary' }, { commit: oid, path: 'absent' },
      ...['large', 'untracked-large', 'outside', 'git-config', 'absent'].map(path => ({ commit: local.headOid, path })),
      { commit: 'worktree:0000000000000000', path: 'small' },
    ];
    const result = JSON.parse((await get('/api/local/blobs', { method: 'POST', headers: api, body: JSON.stringify({ repo, specs }) })).body);
    expect(result[`${oid}:large`]).toMatchObject({ truncated: true, text: null, missing: false });
    expect(result[`${oid}:binary`]).toMatchObject({ binary: true, text: null });
    expect(result[`${oid}:absent`].missing).toBe(true);
    for (const path of ['large', 'untracked-large']) expect(result[`${local.headOid}:${path}`].truncated).toBe(true);
    for (const path of ['outside', 'git-config', 'absent']) expect(result[`${local.headOid}:${path}`].missing).toBe(true);
    expect(result['worktree:0000000000000000:small'].missing).toBe(true);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
it('lists reviews newest first, counts resolution and skips broken files', async () => {
  const get = await start();
  const save = (key: string) => get(`/api/state?key=${key}`, { method: 'PUT', headers: api, body: JSON.stringify({ baseVersion: 0, doc: { title: key, ref: { kind: 'paste', id: key }, viewed: { a: 'x', b: 'y' }, threads: [{ resolved: true }, { resolved: false }] } }) });
  await save('old');
  await new Promise(r => setTimeout(r, 5));
  await save('new');
  await writeFile(join(dir, 'state/reviews', '0'.repeat(64) + '.json'), '{');
  const rows = JSON.parse((await get('/api/states', { headers: api })).body);
  expect(rows.map((row: { key: string }) => row.key)).toEqual(['new', 'old']);
  expect(rows[0]).toMatchObject({ threads: 2, open: 1, viewed: 2 });
});
it('keeps only the eight latest worktree snapshots', async () => {
  const { repo } = await gitRepo();
  try {
    const get = await start();
    const heads: string[] = [];
    for (let i = 0; i < 9; i++) {
      await writeFile(join(repo, 'a'), `${i}\n`);
      const local = JSON.parse((await get(`/api/local/diff?repo=${encodeURIComponent(repo)}`, { headers: api })).body);
      heads.push(local.headOid);
    }
    const specs = [heads[0], heads[1], heads[8]].map(commit => ({ commit, path: 'a' }));
    const response = await get('/api/local/blobs', { method: 'POST', headers: api, body: JSON.stringify({ repo, specs }) });
    const blobs = JSON.parse(response.body);
    expect(blobs[`${heads[0]}:a`].missing).toBe(true);
    expect(blobs[`${heads[1]}:a`].text).toBe('1\n');
    expect(blobs[`${heads[8]}:a`].text).toBe('8\n');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

it('returns missing for unknown worktree identifiers', async () => {
  const { repo } = await gitRepo();
  try {
    const get = await start();
    const response = await get('/api/local/blobs', { method: 'POST', headers: api, body: JSON.stringify({ repo, specs: [{ commit: 'worktree:unknown', path: 'a' }] }) });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)['worktree:unknown:a']).toEqual({ text: null, binary: false, truncated: false, missing: true });
  } finally { await rm(repo, { recursive: true, force: true }); }
});
