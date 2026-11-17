import * as http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, realpath, stat, lstat, mkdir, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, extname, resolve, sep, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { BlobResult, LocalDiff, ReviewDoc, ReviewSummaryRow } from '../src/types.ts';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9_./-]{1,250}$/;
function allowedPath(path: string, diff: boolean): boolean {
  const [base, query, ...extra] = path.split('?');
  if (extra.length || (diff && query !== undefined)) return false;
  const m = /^repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(.*)$/.exec(base);
  if (!m || [m[1], m[2]].some(p => p === '.' || p === '..')) return false;
  const tail = m[3];
  if (/^commits\/[0-9a-f]{7,40}$/i.test(tail)) {
    return query === undefined || /^(?:page|per_page)=\d+(?:&(?:page|per_page)=\d+)*$/.test(query);
  }
  if (query !== undefined && !/^[A-Za-z0-9_=&.-]*$/.test(query)) return false;
  if ((diff ? /^pulls\/\d+$/ : /^pulls\/\d+(\/files)?$/).test(tail)) return true;
  const parts = tail.startsWith('compare/') ? tail.slice(8).split('...') : [];
  return parts.length === 2 && parts.every(p => REF.test(p));
}
const MB = 1024 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const json = (res: http.ServerResponse, status: number, value: unknown) => send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const missingBlob = (): BlobResult => ({ text: null, binary: false, truncated: false, missing: true });
const truncatedBlob = (): BlobResult => ({ text: null, binary: false, truncated: true, missing: false });
function blob(data: Buffer): BlobResult {
  if (data.length > 5 * MB) return truncatedBlob();
  const binary = data.subarray(0, 8000).includes(0);
  return { text: binary ? null : data.toString('utf8'), binary, truncated: false, missing: false };
}
async function git(root: string, args: string[], diffExit = false): Promise<Buffer> {
  try {
    return (await execFileAsync('git', ['-C', root, '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 30000, maxBuffer: 256 * MB, encoding: 'buffer',
    })).stdout;
  } catch (error) {
    const e = error as { code?: number; stdout?: Buffer };
    if (diffExit && e.code === 1 && Buffer.isBuffer(e.stdout)) return e.stdout;
    throw error;
  }
}
async function repoRoot(repo: unknown): Promise<string> {
  if (typeof repo !== 'string' || !isAbsolute(repo)) throw new ApiError(400, 'repo must be absolute');
  try {
    const root = await realpath(repo);
    if (root !== await realpath((await git(root, ['rev-parse', '--show-toplevel'])).toString().trim())) throw new Error();
    return root;
  } catch { throw new ApiError(404, 'Not a git repository root'); }
}
async function revision(root: string, rev: string): Promise<string> {
  if (!/^[A-Za-z0-9_./~^@{}:+-]{1,200}$/.test(rev) || rev.startsWith('-')) throw new ApiError(400, 'Invalid revision');
  try { return (await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`])).toString().trim(); }
  catch { throw new ApiError(400, 'Invalid revision'); }
}
async function diskBlob(root: string, path: string, budget: number): Promise<{ result: BlobResult; bytes: number }> {
  try {
    const actual = await realpath(resolve(root, path));
    if (!actual.startsWith(root + sep) || actual === join(root, '.git') || actual.startsWith(join(root, '.git') + sep)) return { result: missingBlob(), bytes: 0 };
    const info = await stat(actual);
    if (!info.isFile()) return { result: missingBlob(), bytes: 0 };
    if (info.size > Math.min(5 * MB, budget)) return { result: truncatedBlob(), bytes: 0 };
    const data = await readFile(actual);
    if (data.length > budget) return { result: truncatedBlob(), bytes: 0 };
    return { result: blob(data), bytes: data.length };
  } catch { return { result: missingBlob(), bytes: 0 }; }
}
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
};

function send(res: http.ServerResponse, status: number, body: string | Buffer, contentType = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  if (contentType.startsWith('text/html')) {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
  res.end(body);
}

async function jsonBody(req: http.IncomingMessage, limit = MB): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= limit) chunks.push(Buffer.from(chunk));
  }
  if (size > limit) throw new Error('body-too-large');
  return JSON.stringify(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export function createApp(opts: {
  port: number;
  distDir: string;
  dev: boolean;
  stateDir?: string;
  getToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): http.Server {
  const stateDir = opts.stateDir ?? (process.env.DIFF_REVIEW_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'diff-review'));
  const snapshots = new Map<string, Map<string, BlobResult>>();
  const writers = new Map<string, Promise<unknown>>();
  const version = readFile(new URL('../package.json', import.meta.url), 'utf8').then(s => String(JSON.parse(s).version ?? '0')).catch(() => '0');
  const reviewPath = (key: string) => join(stateDir, 'reviews', `${hash(key)}.json`);
  async function readDoc(key: string): Promise<ReviewDoc | null> {
    try { return JSON.parse(await readFile(reviewPath(key), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async function localDiff(root: string, range: string): Promise<LocalDiff> {
    let left: string, right: string | undefined;
    let title = range ? `Changes since ${range}` : 'Uncommitted changes';
    let author: LocalDiff['author'] = null;
    if (range.endsWith('^!')) {
      right = await revision(root, range.slice(0, -2));
      const parents = (await git(root, ['rev-list', '--parents', '-n', '1', right])).toString().trim().split(' ');
      left = parents[1] ?? EMPTY_TREE;
      const metadata = (await git(root, ['show', '-s', '--format=%s%x00%an%x00%ae', right])).toString().trimEnd().split('\0');
      title = metadata[0]; author = { name: metadata[1], email: metadata[2] };
    } else if (range.includes('..')) {
      const parts = range.split(/(\.\.\.?)/);
      // like git, an empty side means HEAD (`main...` = `main...HEAD`)
      if (parts.length !== 3 || (!parts[0] && !parts[2])) throw new ApiError(400, 'Invalid range');
      left = await revision(root, parts[0] || 'HEAD'); right = await revision(root, parts[2] || 'HEAD');
      if (parts[1] === '...') {
        try { left = (await git(root, ['merge-base', left, right])).toString().trim(); }
        catch { throw new ApiError(400, 'No merge base'); }
      }
      title = `git diff ${range}`;
    } else if (range) left = await revision(root, range);
    else {
      try { left = await revision(root, 'HEAD'); }
      catch {
        try { await git(root, ['symbolic-ref', 'HEAD']); }
        catch { throw new ApiError(400, 'Invalid HEAD'); }
        left = EMPTY_TREE;
      }
    }
    // fixed prefixes: diff.noprefix / diff.mnemonicPrefix / diff.relative in the repo's config would change the paths
    const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative'];
    const build = async () => {
      let diff = (await git(root, [...DIFF, '--find-renames', '--full-index', left, ...(right ? [right] : []), '--'])).toString();
      const targets = new Set<string>();
      if (right) return { diff, targets };
      const tracked = new Set<string>();
      const names = (await git(root, [...DIFF, '--find-renames', '--name-status', '-z', left, '--'])).toString().split('\0');
      for (let i = 0; i < names.length - 1;) {
        const status = names[i++], old = names[i++];
        tracked.add(old);
        const target = /^[RC]/.test(status) ? names[i++] : old;
        tracked.add(target);
        if (status !== 'D') targets.add(target);
      }
      const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).toString().split('\0').filter(Boolean).slice(0, 1000);
      for (const path of untracked) {
        if (tracked.has(path)) continue;
        const info = await lstat(join(root, path));
        targets.add(path);
        const a = `a/${path}`, b = `b/${path}`;
        const quoted = (p: string) => /["\\\n\r\t]/.test(p) ? JSON.stringify(p) : p;
        if (info.size > 5 * MB) {
          // the content's oid makes a replaced large file a different change
          const oid = (await git(root, ['hash-object', '--', path])).toString().trim();
          diff += `diff --git ${quoted(a)} ${quoted(b)}\nnew file mode 100644\nindex ${'0'.repeat(40)}..${oid}\nBinary files /dev/null and ${quoted(b)} differ\n`;
        } else {
          let added = (await git(root, [...DIFF, '--full-index', '--no-index', '--', '/dev/null', path], true)).toString();
          const newline = added.indexOf('\n');
          added = `diff --git ${quoted(a)} ${quoted(b)}` + added.slice(newline);
          diff += added;
        }
      }
      return { diff, targets };
    };
    let { diff, targets } = await build();
    if (!right) {
      // The snapshot must show the same content the diff was made from: take it between two identical diffs.
      let snapshot = new Map<string, BlobResult>();
      for (let attempt = 0; ; attempt++) {
        snapshot = new Map();
        let bytes = 0;
        for (const path of targets) {
          const entry = await diskBlob(root, path, 64 * MB - bytes);
          bytes += entry.bytes; snapshot.set(path, entry.result);
        }
        const again = await build();
        if (again.diff === diff) break;
        diff = again.diff; targets = again.targets;
        // still changing (an agent is writing): no contents, so the files stay on the patch view
        if (attempt === 2) { snapshot = new Map(); break; }
      }
      const headOid = `worktree:${hash(diff).slice(0, 16)}`;
      const key = `${root}\0${headOid}`;
      snapshots.delete(key); snapshots.set(key, snapshot);
      while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
      return { root, range, baseOid: left, headOid, mergeBaseOid: left, title, author, diff };
    }
    const headOid = right;
    return { root, range, baseOid: left, headOid, mergeBaseOid: left, title, author, diff };
  }
  async function localRoutes(req: http.IncomingMessage, res: http.ServerResponse, rawPath: string): Promise<boolean> {
    const url = new URL(rawPath, 'http://localhost');
    const path = url.pathname;
    const method = (expected: string) => { if (req.method !== expected) throw new ApiError(405, 'Method not allowed'); };
    const body = async (limit: number) => JSON.parse(await jsonBody(req, limit));
    if (path === '/api/ping') {
      method('GET'); json(res, 200, { ok: true, name: 'diff-review', version: await version });
    } else if (path === '/api/local/diff') {
      method('GET'); json(res, 200, await localDiff(await repoRoot(url.searchParams.get('repo')), url.searchParams.get('range') ?? ''));
    } else if (path === '/api/local/blobs') {
      method('POST');
      const input = await body(5 * MB);
      if (!input || !Array.isArray(input.specs) || input.specs.length > 200) throw new ApiError(400, 'Invalid specs');
      const root = await repoRoot(input.repo);
      const results: Record<string, BlobResult> = Object.create(null);
      for (const spec of input.specs) {
        if (!spec || typeof spec.commit !== 'string' || typeof spec.path !== 'string' || spec.path.includes('\0') || !(/^[a-f0-9]{40}$/i.test(spec.commit) || spec.commit.startsWith('worktree:'))) throw new ApiError(400, 'Invalid blob spec');
        let result = missingBlob();
        if (spec.commit.startsWith('worktree:')) result = snapshots.get(`${root}\0${spec.commit}`)?.get(spec.path) ?? result;
        else {
          try {
            const object = `${spec.commit}:${spec.path}`;
            const size = Number((await git(root, ['cat-file', '-s', object])).toString());
            result = size > 5 * MB ? truncatedBlob() : blob(await git(root, ['cat-file', 'blob', object]));
          } catch {}
        }
        results[`${spec.commit}:${spec.path}`] = result;
      }
      json(res, 200, results);
    } else if (path === '/api/paste') {
      method('POST'); const input = await body(50 * MB);
      if (!input || typeof input.diff !== 'string') throw new ApiError(400, 'Invalid diff');
      const id = hash(input.diff);
      await mkdir(join(stateDir, 'pastes'), { recursive: true });
      await writeFile(join(stateDir, 'pastes', `${id}.diff`), input.diff);
      json(res, 200, { id });
    } else if (path.startsWith('/api/paste/')) {
      method('GET'); const id = path.slice('/api/paste/'.length);
      if (!/^[a-f0-9]{64}$/.test(id)) throw new ApiError(400, 'Invalid paste id');
      try { send(res, 200, await readFile(join(stateDir, 'pastes', `${id}.diff`))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'Paste not found'); throw error; }
    } else if (path === '/api/state') {
      const key = url.searchParams.get('key');
      if (!key) throw new ApiError(400, 'Missing key');
      if (req.method === 'GET') {
        const doc = await readDoc(key);
        if (!doc) throw new ApiError(404, 'State not found');
        json(res, 200, doc);
      } else {
        method('PUT'); const input = await body(5 * MB);
        const object = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
        if (!input || !object(input.doc) || !Array.isArray(input.doc.threads) || !object(input.doc.viewed) || !object(input.doc.ref) || !Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0) throw new ApiError(400, 'Invalid review document');
        const write = (writers.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
          const stored = await readDoc(key);
          if (input.baseVersion !== (stored?.version ?? 0)) { json(res, 409, { doc: stored }); return; }
          const doc: ReviewDoc = { ...input.doc, key, version: input.baseVersion + 1, updatedAt: new Date().toISOString() };
          const target = reviewPath(key), temp = `${target}.${randomUUID()}.tmp`;
          await mkdir(dirname(target), { recursive: true });
          try { await writeFile(temp, JSON.stringify(doc)); await rename(temp, target); }
          finally { await unlink(temp).catch(() => {}); }
          json(res, 200, { version: doc.version });
        });
        writers.set(key, write);
        try { await write; } finally { if (writers.get(key) === write) writers.delete(key); }
      }
    } else if (path === '/api/states') {
      method('GET'); const rows: ReviewSummaryRow[] = [];
      let files: string[];
      try { files = await readdir(join(stateDir, 'reviews')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; files = []; }
      for (const file of files.filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
        try {
          const doc: ReviewDoc = JSON.parse(await readFile(join(stateDir, 'reviews', file), 'utf8'));
          rows.push({ key: doc.key, ref: doc.ref, title: doc.title, updatedAt: doc.updatedAt, threads: doc.threads.length, open: doc.threads.filter(t => !t.resolved).length, viewed: Object.keys(doc.viewed).length });
        } catch { /* Skip unreadable reviews. */ }
      }
      json(res, 200, rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    } else return false;
    return true;
  }
  const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const origins = new Set([...hosts].map(host => `http://${host}`));
  if (opts.dev) {
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
  }
  const distDir = resolve(opts.distDir);
  const inside = (path: string, root = distDir) => path === root || path.startsWith(root + sep);
  const canonicalDist = realpath(distDir).catch(() => distDir);
  const getToken = opts.getToken ?? (async () => (await execFileAsync('gh', ['auth', 'token'])).stdout.trim());
  const fetchImpl = opts.fetchImpl ?? fetch;
  let token: Promise<string> | undefined;
  function cachedToken() {
    token ??= getToken().catch(error => { token = undefined; throw error; });
    return token;
  }
  async function proxy(url: string, init: RequestInit): Promise<Response> {
    const originalToken = cachedToken();
    let result = await fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `bearer ${await originalToken}`, 'User-Agent': 'diff-review' } });
    if (result.status === 401) {
      await result.body?.cancel();
      if (token === originalToken) token = undefined;
      result = await fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `bearer ${await cachedToken()}`, 'User-Agent': 'diff-review' } });
    }
    return result;
  }
  async function staticFile(path: string): Promise<Buffer | null> {
    try {
      const actual = await realpath(path);
      if (!inside(actual, await canonicalDist)) throw new Error('forbidden');
      if (!(await stat(actual)).isFile()) return null;
      return await readFile(actual);
    } catch (error) {
      if (error instanceof Error && error.message === 'forbidden') throw error;
      if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
      throw error;
    }
  }
  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!hosts.has(req.headers.host ?? '') || req.method === 'OPTIONS') return send(res, 403, 'Forbidden');
    const rawPath = req.url ?? '/';
    if (rawPath.startsWith('/api/')) {
      if (req.headers['x-ghr'] !== '1' || (req.headers.origin !== undefined && !origins.has(req.headers.origin))) return send(res, 403, 'Forbidden');
      if (await localRoutes(req, res, rawPath)) return;
      if (rawPath === '/api/graphql') {
        if (req.method !== 'POST') return json(res, 405, { message: 'Method not allowed' });
        let body: string;
        try { body = await jsonBody(req); }
        catch (error) { return json(res, error instanceof Error && error.message === 'body-too-large' ? 413 : 400, { message: 'Invalid JSON body' }); }
        const result = await proxy('https://api.github.com/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        return send(res, result.status, await result.text(), 'application/json; charset=utf-8');
      }
      if (req.method !== 'GET') return json(res, 405, { message: 'Method not allowed' });
      if (rawPath.startsWith('/api/diff/')) {
        const path = rawPath.slice('/api/diff/'.length);
        if (!allowedPath(path, true)) return json(res, 400, { message: 'Invalid diff path' });
        const result = await proxy(`https://api.github.com/${path}`, { headers: { Accept: 'application/vnd.github.diff', 'X-GitHub-Api-Version': '2022-11-28' } });
        return send(res, result.status, await result.text(), 'text/plain; charset=utf-8');
      }
      if (!rawPath.startsWith('/api/rest/')) return json(res, 404, { message: 'Not found' });
      const path = rawPath.slice('/api/rest/'.length);
      if (!allowedPath(path, false)) return json(res, 400, { message: 'Invalid REST path' });
      const result = await proxy(`https://api.github.com/${path}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
      const link = result.headers.get('link');
      if (link !== null) res.setHeader('Link', link);
      return send(res, result.status, await result.text(), 'application/json; charset=utf-8');
    }
    if (req.method !== 'GET') return json(res, 405, { message: 'Method not allowed' });
    let path: string;
    try { path = decodeURIComponent(rawPath.split('?')[0]); }
    catch { return send(res, 400, 'Invalid path'); }
    if (!path.startsWith('/') || path.includes('\\') || path.includes('\0')) return send(res, 403, 'Forbidden');
    const filePath = resolve(distDir, '.' + path);
    if (!inside(filePath)) return send(res, 403, 'Forbidden');
    let body: Buffer | null;
    try { body = await staticFile(filePath); }
    catch (error) {
      if (error instanceof Error && error.message === 'forbidden') return send(res, 403, 'Forbidden');
      throw error;
    }
    const foundFile = body !== null;
    let contentType = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    if (body === null) {
      try { body = await staticFile(resolve(distDir, 'index.html')); }
      catch { return send(res, 500, 'run npm run build'); }
      if (body === null) return send(res, 500, 'run npm run build');
      contentType = MIME['.html'];
    }
    res.setHeader('Cache-Control', foundFile && path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    send(res, 200, body, contentType);
  }
  return http.createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) json(res, error instanceof ApiError ? error.status : error instanceof SyntaxError ? 400 : error instanceof Error && error.message === 'body-too-large' ? 413 : 500, { message: error instanceof ApiError ? error.message : 'Request failed' });
      else res.end();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const port = Number(process.env.PORT || 7777);
  const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
  createApp({ port, distDir, dev: process.env.GHR_DEV === '1' }).listen(port, '127.0.0.1', () => {
    console.log(`diff-review on http://127.0.0.1:${port}`);
  });
}
