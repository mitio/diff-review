import * as http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REST_PATH = /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(pulls\/\d+(\/files)?|compare\/[0-9a-f]{7,40}\.\.\.[0-9a-f]{7,40})(\?[A-Za-z0-9_=&.-]*)?$/;
const DIFF_PATH = /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/\d+$/;
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

async function jsonBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 1024 * 1024) chunks.push(Buffer.from(chunk));
  }
  if (size > 1024 * 1024) throw new Error('body-too-large');
  return JSON.stringify(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export function createApp(opts: {
  port: number;
  distDir: string;
  dev: boolean;
  getToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): http.Server {
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
    let result = await fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `bearer ${await originalToken}`, 'User-Agent': 'gh-review' } });
    if (result.status === 401) {
      await result.body?.cancel();
      if (token === originalToken) token = undefined;
      result = await fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `bearer ${await cachedToken()}`, 'User-Agent': 'gh-review' } });
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
      if (rawPath === '/api/graphql') {
        if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
        let body: string;
        try { body = await jsonBody(req); }
        catch (error) { return send(res, error instanceof Error && error.message === 'body-too-large' ? 413 : 400, 'Invalid JSON body'); }
        const result = await proxy('https://api.github.com/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        return send(res, result.status, await result.text(), 'application/json; charset=utf-8');
      }
      if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
      if (rawPath.startsWith('/api/diff/')) {
        const path = rawPath.slice('/api/diff/'.length);
        if (!DIFF_PATH.test(path)) return send(res, 400, 'Invalid diff path');
        const result = await proxy(`https://api.github.com/${path}`, { headers: { Accept: 'application/vnd.github.diff', 'X-GitHub-Api-Version': '2022-11-28' } });
        return send(res, result.status, await result.text(), 'text/plain; charset=utf-8');
      }
      if (!rawPath.startsWith('/api/rest/')) return send(res, 404, 'Not found');
      const path = rawPath.slice('/api/rest/'.length);
      if (!REST_PATH.test(path)) return send(res, 400, 'Invalid REST path');
      const result = await proxy(`https://api.github.com/${path}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
      const link = result.headers.get('link');
      if (link !== null) res.setHeader('Link', link);
      return send(res, result.status, await result.text(), 'application/json; charset=utf-8');
    }
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
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
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 502, 'Request failed');
      else res.end();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 7777);
  const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
  createApp({ port, distDir, dev: process.env.GHR_DEV === '1' }).listen(port, '127.0.0.1', () => {
    console.log(`gh-review on http://127.0.0.1:${port}`);
  });
}
