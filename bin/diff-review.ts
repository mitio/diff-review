#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { LocalDiff, ReviewDoc, ReviewRef } from '../src/types.ts';
import { appPath, parseReviewInput, refKey } from '../src/lib/refs.ts';
import { exportMarkdown, sourceLine } from '../src/lib/export.ts';

export type Command = { action: 'help' } | {
  action: 'review' | 'export'; print: boolean; all: boolean; port?: number;
  source: { kind: 'local'; range: string } | { kind: 'stdin' } | { kind: 'file'; path: string } | { kind: 'ref'; ref: ReviewRef };
};

export function parseArgs(argv: string[], env: { isFile(p: string): boolean }): Command {
  if (argv.includes('-h') || argv.includes('--help')) return { action: 'help' };
  const args = [...argv];
  let action: 'review' | 'export' = args[0] === 'export' ? (args.shift(), 'export') : 'review';
  let print = false, all = false, port: number | undefined, commit: string | undefined;
  const positional: string[] = [];
  let flags = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags && arg === 'export' && positional.length === 0 && action === 'review') { action = 'export'; continue; }
    if (flags && arg === '--') { flags = false; continue; }
    if (flags && arg === '--print') print = true;
    else if (flags && arg === '--all') all = true;
    else if (flags && (arg === '-c' || arg === '--commit' || arg === '--port')) {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`missing value for ${arg}`);
      if (arg === '--port') {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('invalid port');
        port = Number(value);
      } else {
        if (commit !== undefined) throw new Error('only one commit is allowed');
        commit = value;
      }
    } else if (flags && arg.startsWith('-') && arg !== '-') throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1 || (commit !== undefined && positional.length)) throw new Error('only one range or source is allowed');
  if (all && action !== 'export') throw new Error('--all requires export');
  let source: Exclude<Command, { action: 'help' }>['source'];
  const input = positional[0];
  if (commit !== undefined) source = { kind: 'local', range: `${commit}^!` };
  else if (input === undefined) source = { kind: 'local', range: '' };
  else if (input === '-') source = { kind: 'stdin' };
  else {
    const ref = (/^https?:\/\//.test(input) || /^[^/]+\/[^/]+#\d+$/.test(input)) ? parseReviewInput(input) : null;
    if (ref) source = { kind: 'ref', ref };
    else if (/\.(diff|patch)$/.test(input) && env.isFile(input)) source = { kind: 'file', path: input };
    else source = { kind: 'local', range: input };
  }
  return { action, source, print, all, ...(port === undefined ? {} : { port }) };
}

const usage = `diff-review [<range>]           review a local git diff in the current repo ('' = uncommitted incl. untracked)
diff-review -c|--commit <rev>   one commit (<rev>^!)
diff-review <file.diff|.patch>  review a diff file;  \`-\` reads stdin (git diff | diff-review -)
diff-review <github-url>        PR / commit / compare URL
diff-review export [<same args>] [--all]   print the review's comments as Markdown to stdout
diff-review --print             print the URL instead of opening it

-h, --help                     show help
--port <n>                     server port (default: PORT or 7777)
--all                          include resolved comments in export
`;
const exec = promisify(execFile);
const root = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const stateDir = process.env.DIFF_REVIEW_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'diff-review');

async function ensureServer(port: number): Promise<string> {
  const base = `http://127.0.0.1:${port}`;
  const ping = async (): Promise<boolean> => {
    let response: Response;
    try { response = await fetch(`${base}/api/ping`, { headers: { 'x-ghr': '1' }, signal: AbortSignal.timeout(1000) }); }
    catch { return false; }
    let identity: { name?: string };
    try { identity = await response.json(); }
    catch { throw new Error(`port ${port} is used by something else (an old gh-review server? stop it, or use --port)`); }
    if (identity?.name !== 'diff-review') throw new Error(`port ${port} is used by something else`);
    return response.ok;
  };
  if (await ping()) return base;
  if (!existsSync(join(root, 'dist/index.html'))) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npm', ['run', 'build'], { cwd: root, stdio: ['ignore', 2, 2] });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error('npm run build failed')));
    });
  }
  await mkdir(stateDir, { recursive: true });
  const logPath = join(stateDir, 'server.log');
  const log = await open(logPath, 'a');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'server/server.ts')], {
        cwd: root, env: { ...process.env, PORT: String(port) }, detached: true, stdio: ['ignore', log.fd, log.fd],
      });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  } catch { throw new Error(`server failed to start; see ${logPath}`); }
  finally { await log.close(); }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    if (await ping()) return base;
  }
  throw new Error(`server failed to start; see ${logPath}`);
}

async function main() {
  const command = parseArgs(process.argv.slice(2), { isFile: p => { try { return statSync(p).isFile(); } catch { return false; } } });
  if (command.action === 'help') { process.stdout.write(usage); return; }
  const port = command.port ?? Number(process.env.PORT || 7777);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  let ref: ReviewRef;
  if (command.source.kind === 'ref') ref = command.source.ref;
  else if (command.source.kind === 'local') {
    let repo: string;
    try { repo = realpathSync((await exec('git', ['rev-parse', '--show-toplevel'])).stdout.trim()); }
    catch { throw new Error('not in a git repository'); }
    ref = { kind: 'local', repo, range: command.source.range };
  } else {
    const chunks: Buffer[] = [];
    let diff: string;
    if (command.source.kind === 'file') diff = await readFile(command.source.path, 'utf8');
    else { for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); diff = Buffer.concat(chunks).toString('utf8'); }
    const base = await ensureServer(port);
    const response = await fetch(`${base}/api/paste`, { method: 'POST', headers: { 'x-ghr': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ diff }) });
    if (!response.ok) throw new Error(`paste failed: ${response.status}`);
    const { id } = await response.json() as { id: string };
    ref = { kind: 'paste', id };
  }
  if (command.action === 'export' && ref.kind === 'pr') throw new Error('PR comments live on GitHub');
  const base = await ensureServer(port);
  if (command.action === 'export') {
    const key = refKey(ref);
    const response = await fetch(`${base}/api/state?${new URLSearchParams({ key })}`, { headers: { 'x-ghr': '1' } });
    if (response.status === 404) throw new Error(`no comments stored for ${key}`);
    if (!response.ok) throw new Error(`could not read comments: ${response.status}`);
    const doc = await response.json() as ReviewDoc;
    let order: string[] | undefined;
    if (ref.kind === 'local') {
      try {
        const result = await fetch(`${base}/api/local/diff?${new URLSearchParams({ repo: ref.repo, range: ref.range })}`, { headers: { 'x-ghr': '1' } });
        if (result.ok) {
          const { diff } = await result.json() as LocalDiff;
          order = [...diff.matchAll(/^diff --git (?:"(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/gm)].map(m => (m[1].startsWith('"') ? JSON.parse(m[1]) as string : m[1]).slice(2));
        }
      } catch { /* File order is optional. */ }
    }
    process.stdout.write(exportMarkdown(doc, { source: sourceLine(ref), order, includeResolved: command.all }));
  } else {
    const url = base + appPath(ref, 'diff');
    if (command.print) process.stdout.write(url + '\n');
    else await exec(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
