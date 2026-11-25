import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createApp } from '../server/server.ts';
import { refKey } from '../src/lib/refs.ts';
import { parseArgs } from './diff-review.ts';

const env = { isFile: (p: string) => p === 'x.patch' };
describe('parseArgs', () => {
  it('parses server subcommands', () => {
    expect(parseArgs(['server'], env)).toEqual({ action: 'server', op: 'status' });
    expect(parseArgs(['server', 'restart', '--port', '7800'], env)).toEqual({ action: 'server', op: 'restart', port: 7800 });
    expect(() => parseArgs(['server', 'stop', 'now'], env)).toThrow('unknown server argument');
  });
  it('selects local ranges and single commits', () => {
    expect(parseArgs([], env)).toMatchObject({ action: 'review', source: { kind: 'local', range: '' } });
    expect(parseArgs(['main...HEAD'], env)).toMatchObject({ source: { kind: 'local', range: 'main...HEAD' } });
    expect(parseArgs(['-c', 'HEAD'], env)).toMatchObject({ source: { kind: 'local', range: 'HEAD^!' } });
    expect(parseArgs(['--commit', 'main'], env)).toMatchObject({ source: { kind: 'local', range: 'main^!' } });
  });
  it('selects files, stdin and remote refs', () => {
    expect(parseArgs(['x.patch'], env)).toMatchObject({ source: { kind: 'file', path: 'x.patch' } });
    expect(parseArgs(['missing.diff'], env)).toMatchObject({ source: { kind: 'local', range: 'missing.diff' } });
    expect(parseArgs(['-'], env)).toMatchObject({ source: { kind: 'stdin' } });
    expect(parseArgs(['o/r#1'], env)).toMatchObject({ source: { kind: 'ref', ref: { kind: 'pr', number: 1 } } });
    expect(parseArgs(['https://github.com/o/r/commit/abcdef0'], env)).toMatchObject({ source: { kind: 'ref', ref: { kind: 'commit', sha: 'abcdef0' } } });
    expect(parseArgs(['github.com/o/r/pull/7/changes'], env)).toMatchObject({ source: { kind: 'ref', ref: { kind: 'pr', number: 7 } } });
  });
  it('parses flags and rejects ambiguous or invalid arguments', () => {
    expect(parseArgs(['export', '--all', '--port', '8000', '--print'], env)).toMatchObject({ action: 'export', all: true, print: true, port: 8000 });
    for (const arg of ['-h', '--help']) expect(parseArgs([arg], env)).toEqual({ action: 'help' });
    for (const args of [['a', 'b'], ['-c'], ['--wat'], ['--port', '0'], ['--port', '65536'], ['--port', 'a'], ['-c', 'a', 'b'], ['--all']]) expect(() => parseArgs(args, env)).toThrow();
  });
});

const exec = promisify(execFile);
let app: ReturnType<typeof createApp> | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (app) await new Promise<void>((resolve, reject) => app!.close(e => e ? reject(e) : resolve()));
  app = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const port = address.port;
  await new Promise<void>(r => server.close(() => r()));
  return port;
}
it('runs through Node from a repo and exports stored comments', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'diff-review-cli-')));
  const port = await freePort();
  app = createApp({ port, distDir: join(dir, 'dist'), stateDir: join(dir, 'state'), dev: false });
  await new Promise<void>(resolve => app!.listen(port, '127.0.0.1', resolve));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  await exec('git', ['init', repo]);
  const cli = join(dir, 'diff-review');
  await symlink(fileURLToPath(new URL('./diff-review.ts', import.meta.url)), cli);
  const run = (...args: string[]) => exec(process.execPath, [cli, '--port', String(port), ...args], { cwd: repo });
  const url = new URL((await run('--print')).stdout.trim());
  expect(url.pathname).toBe('/local');
  expect(url.searchParams.get('repo')).toBe(repo);
  expect(url.searchParams.get('range')).toBe('');
  const ref = { kind: 'local' as const, repo, range: '' }, key = refKey(ref);
  await expect(run('export')).rejects.toMatchObject({ code: 1, stderr: `no comments stored for ${key}\n` });
  await expect(run('export', 'o/r#1')).rejects.toMatchObject({ code: 1, stderr: 'PR comments live on GitHub\n' });
  const saved = await fetch(`http://127.0.0.1:${port}/api/state?key=${encodeURIComponent(key)}`, {
    method: 'PUT', headers: { 'x-ghr': '1' }, body: JSON.stringify({ baseVersion: 0, doc: { ref, title: 'CLI review', viewed: {}, threads: [{ id: 't', path: 'a', subjectType: 'FILE', side: 'RIGHT', line: null, startLine: null, startSide: null, quote: [], outdated: false, resolved: false, comments: [{ id: 'c', body: 'Please fix', createdAt: '' }] }] } }),
  });
  expect(saved.status).toBe(200);
  const result = await run('export');
  expect(result.stdout).toContain('# Review: CLI review');
  expect(result.stdout).toContain('### a (file)\nPlease fix');
  await writeFile(join(repo, 'x.diff'), 'diff text');
  const paste = new URL((await run('--print', 'x.diff')).stdout.trim());
  expect(paste.pathname).toMatch(/^\/paste\/[a-f0-9]{64}$/);
});
