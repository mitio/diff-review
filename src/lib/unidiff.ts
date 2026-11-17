import type { PrFile } from '../types';

interface Parts {
  path: string;
  previousPath?: string;
  status: string;
  oldMode?: string;
  newMode?: string;
  oldOid?: string;
  newOid?: string;
  patch?: string;
}

export function fingerprint(p: Parts): string {
  const text = JSON.stringify([p.path, p.previousPath, p.status, p.oldMode, p.newMode, p.oldOid, p.newOid, p.patch]);
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}

function unquoteGitPath(q: string): string {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 1; i < q.length - 1; i++) {
    const c = q[i];
    if (c !== '\\') {
      const code = q.codePointAt(i)!;
      bytes.push(...enc.encode(String.fromCodePoint(code)));
      if (code > 0xffff) i++;
      continue;
    }
    const n = q[++i];
    if (/[0-7]/.test(n)) {
      const octal = /^[0-7]{1,3}/.exec(q.slice(i))![0];
      bytes.push(parseInt(octal, 8)); i += octal.length - 1;
    } else bytes.push(({n:10,t:9,r:13,'"':34,'\\':92,a:7,b:8,f:12,v:11} as Record<string, number>)[n] ?? n.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function path(raw: string, prefix = ''): string | null {
  if (raw.startsWith('"')) raw = unquoteGitPath(/^"(?:[^"\\]|\\.)*"/.exec(raw)?.[0] ?? raw);
  else raw = raw.split('\t')[0];
  if (raw === '/dev/null') return null;
  return prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function headerPaths(header: string): [string | null, string | null] {
  const q = '"(?:[^"\\\\]|\\\\.)*"';
  const quoted = new RegExp(`^(${q}|.+?) (${q}|.+)$`).exec(header);
  if (quoted && (header.startsWith('"') || quoted[2].startsWith('"'))) return [path(quoted[1], 'a/'), path(quoted[2], 'b/')];
  const splits = [...header.matchAll(/ (?=b\/|")/g)];
  if (header.startsWith('a/')) {
    const candidates = splits.map(split => {
      const i = split.index!;
      return [path(header.slice(0, i), 'a/'), path(header.slice(i + 1), 'b/')] as [string | null, string | null];
    });
    const same = candidates.filter(([a, b]) => a === b);
    if (same.length === 1) return same[0];
    if (candidates.length === 1) return candidates[0];
  }
  const simple = /^(\S+) (\S+)$/.exec(header);
  return simple ? [path(simple[1], 'a/'), path(simple[2], 'b/')] : [null, null];
}

export function parseUnifiedDiff(text: string): PrFile[] {
  const files: PrFile[] = [];
  const seen = new Set<string>();
  let current: {oldPath: string | null; newPath: string | null; status: PrFile['status']; parts: Partial<Parts>; patch: string[]; binary: boolean} | undefined;
  let oldLeft = 0, newLeft = 0;
  const finish = () => {
    if (!current) return;
    const name = current.newPath ?? current.oldPath;
    if (!name || seen.has(name)) return;
    const patch = !current.binary && current.patch.length ? current.patch.join('\n') : undefined;
    const previousPath = (current.status === 'renamed' || current.status === 'copied') && current.oldPath ? current.oldPath : undefined;
    const file: PrFile = {path:name, ...(previousPath !== undefined ? {previousPath} : {}), status:current.status,
      additions:current.patch.filter(l => l.startsWith('+')).length,
      deletions:current.patch.filter(l => l.startsWith('-')).length,
      ...(patch !== undefined ? {patch} : {}), viewed:'UNVIEWED'};
    file.fingerprint = fingerprint({...current.parts, ...file});
    files.push(file); seen.add(name);
  };
  const begin = (oldPath: string | null, newPath: string | null) => {
    finish(); current = {oldPath, newPath, status:'modified', parts:{}, patch:[], binary:false};
    oldLeft = newLeft = 0;
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) { begin(...headerPaths(line.slice(11))); continue; }
    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) { finish(); current = undefined; continue; }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (current && hunk) {
      oldLeft = Number(hunk[2] ?? 1); newLeft = Number(hunk[4] ?? 1);
      current.patch.push(line); continue;
    }
    if (current && line.startsWith('\\ No newline at end of file') && current.patch.length) { current.patch.push(line); continue; }
    // pasted diffs often lose the space of blank context lines
    if (current && oldLeft > 0 && newLeft > 0 && raw === '') {
      current.patch.push(' ');
      oldLeft--; newLeft--;
      continue;
    }
    if (current && (oldLeft > 0 || newLeft > 0) && /^[ +\-]/.test(raw)) {
      current.patch.push(raw);
      if (raw[0] !== '+') oldLeft--;
      if (raw[0] !== '-') newLeft--;
      continue;
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      if (!current || current.patch.length || current.binary) begin(null, null);
      current!.oldPath = path(line.slice(4), 'a/');
      current!.newPath = path(lines[++i].replace(/\r$/, '').slice(4), 'b/');
      if (current!.oldPath === null) current!.status = 'added';
      else if (current!.newPath === null) current!.status = 'removed';
      continue;
    }
    if (!current || current.patch.length) continue;
    if (line.startsWith('new file mode ')) { current.status = 'added'; current.parts.newMode = line.slice(14); }
    else if (line.startsWith('deleted file mode ')) { current.status = 'removed'; current.parts.oldMode = line.slice(18); }
    else if (line.startsWith('old mode ')) current.parts.oldMode = line.slice(9);
    else if (line.startsWith('new mode ')) current.parts.newMode = line.slice(9);
    else if (line.startsWith('rename from ')) { current.status = 'renamed'; current.oldPath = path(line.slice(12)); }
    else if (line.startsWith('rename to ')) { current.status = 'renamed'; current.newPath = path(line.slice(10)); }
    else if (line.startsWith('copy from ')) { current.status = 'copied'; current.oldPath = path(line.slice(10)); }
    else if (line.startsWith('copy to ')) { current.status = 'copied'; current.newPath = path(line.slice(8)); }
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') current.binary = true;
    else {
      const index = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/.exec(line);
      if (index) {
        current.parts.oldOid = index[1]; current.parts.newOid = index[2];
        if (index[3]) current.parts.oldMode = current.parts.newMode = index[3];
      }
    }
  }
  finish();
  return files;
}
