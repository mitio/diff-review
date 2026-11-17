import type { BlobResult, BlobSpec, LocalDiff, PrData, PrFile, ReviewRef } from '../types';
import { gql, local, localText, rest, restText } from './api';
import { githubUrl, refKey } from './refs';
import { fingerprint, parseUnifiedDiff } from './unidiff';

type Ref<K extends ReviewRef['kind']> = Extract<ReviewRef, {kind: K}>;
interface RestFile {
  filename: string;
  previous_filename?: string;
  status: PrFile['status'];
  sha: string;
  additions: number;
  deletions: number;
  patch?: string;
}
interface Commit {
  sha: string;
  commit: {message: string};
  author: {login: string; avatar_url: string} | null;
  parents: Array<{sha: string}>;
  files: RestFile[];
}
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const short = (oid: string) => oid.slice(0, 7);

function data(ref: ReviewRef, files: PrFile[], meta: Pick<PrData, 'title' | 'baseOid' | 'headOid' | 'mergeBaseOid' | 'baseRefName' | 'headRefName'> & Partial<PrData>): PrData {
  return {ref, id:refKey(ref), url:githubUrl(ref) ?? '', state:'', isDraft:false, author:null,
    viewer:{login:'you',avatarUrl:''}, threads:[], pendingReviewId:null,
    additions:files.reduce((n, f) => n + f.additions, 0), deletions:files.reduce((n, f) => n + f.deletions, 0),
    changedFiles:files.length, files, ...meta};
}

function restFile(f: RestFile): PrFile {
  const file: PrFile = {path:f.filename, ...(f.previous_filename ? {previousPath:f.previous_filename} : {}),
    status:f.status, additions:f.additions, deletions:f.deletions, ...(f.patch !== undefined ? {patch:f.patch} : {}), viewed:'UNVIEWED'};
  file.fingerprint = fingerprint({...file, newOid:f.sha});
  return file;
}

async function withDiff(path: string, raw: RestFile[], capped: boolean): Promise<{files: PrFile[]; truncated: boolean}> {
  const files = raw.map(restFile);
  if (!capped && !raw.some(f => f.additions + f.deletions > 0 && !f.patch)) return {files, truncated:false};
  try {
    const full = parseUnifiedDiff(await restText(path.split('?')[0]));
    if (capped) return {files:full, truncated:false};
    const byPath = new Map(full.map(f => [f.path, f]));
    const byPrevious = new Map(full.filter(f => f.previousPath).map(f => [f.previousPath!, f]));
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.patch || f.additions + f.deletions === 0) continue;
      const match = byPath.get(f.path) ?? byPrevious.get(f.path) ?? (f.previousPath ? byPath.get(f.previousPath) ?? byPrevious.get(f.previousPath) : undefined);
      if (match?.patch !== undefined) {
        f.patch = match.patch;
        f.fingerprint = fingerprint({...f, newOid:raw[i].sha});
      }
    }
    return {files, truncated:false};
  } catch { return {files, truncated:capped}; }
}

export async function loadCommit(ref: Ref<'commit'>): Promise<PrData> {
  const path = `repos/${ref.owner}/${ref.repo}/commits/${ref.sha}?per_page=100`;
  let page = await rest<Commit>(path);
  const first = page.data;
  const raw = [...first.files];
  let pages = 1;
  let next: RegExpExecArray | null;
  while ((next = /<([^>]+)>;\s*rel="next"/.exec(page.link ?? '')) && pages < 30) {
    const url = new URL(next[1], 'https://api.github.com/');
    page = await rest<Commit>(url.pathname.replace(/^\//, '') + url.search);
    raw.push(...page.data.files); pages++;
  }
  const root = !first.parents.length;
  if (root) for (const f of raw) f.status = 'added';
  const {files, truncated} = await withDiff(path, raw, raw.length >= 3000 || !!next);
  const baseOid = first.parents[0]?.sha ?? EMPTY_TREE;
  return data(ref, files, {title:first.commit.message.split(/\r?\n/)[0],
    author:first.author ? {login:first.author.login,avatarUrl:first.author.avatar_url} : null,
    baseOid, headOid:first.sha, mergeBaseOid:baseOid, baseRefName:short(baseOid), headRefName:short(first.sha),
    changedFiles:files.length + (truncated ? 1 : 0), truncated});
}

export async function loadCompare(ref: Ref<'compare'>): Promise<PrData> {
  const {data:resolved} = await gql<{repository: {base: {oid: string} | null; head: {oid: string} | null} | null}>(
    `query($owner:String!,$repo:String!,$base:String!,$head:String!) { repository(owner:$owner,name:$repo) { base:object(expression:$base) { oid ... on Commit { __typename } } head:object(expression:$head) { oid ... on Commit { __typename } } } }`,
    {owner:ref.owner, repo:ref.repo, base:ref.base, head:ref.head});
  const baseOid = resolved.repository?.base?.oid, headOid = resolved.repository?.head?.oid;
  if (!baseOid || !headOid) throw new Error('Could not resolve comparison refs');
  const path = `repos/${ref.owner}/${ref.repo}/compare/${baseOid}...${headOid}?per_page=1`;
  const {data:comparison} = await rest<{merge_base_commit: {sha: string}; files: RestFile[]}>(path);
  const {files, truncated} = await withDiff(path, comparison.files, comparison.files.length >= 300);
  return data(ref, files, {title:`${ref.base}...${ref.head}`, baseOid, headOid, mergeBaseOid:comparison.merge_base_commit.sha,
    baseRefName:ref.base, headRefName:ref.head, changedFiles:files.length + (truncated ? 1 : 0), truncated});
}

export async function loadLocal(ref: Ref<'local'>): Promise<PrData> {
  const result = await local<LocalDiff>(`local/diff?${new URLSearchParams({repo:ref.repo,range:ref.range})}`);
  return data(ref, parseUnifiedDiff(result.diff), {title:result.title, baseOid:result.baseOid, headOid:result.headOid,
    mergeBaseOid:result.mergeBaseOid, baseRefName:result.baseOid === EMPTY_TREE ? 'empty tree' : short(result.baseOid),
    headRefName:!result.headOid || result.headOid.startsWith('worktree:') ? 'working tree' : short(result.headOid)});
}

export async function loadPaste(ref: Ref<'paste'>): Promise<PrData> {
  const text = await localText(`paste/${encodeURIComponent(ref.id)}`);
  const subject = /^Subject:[ \t]*(.*)$/m.exec(text)?.[1].replace(/\r$/, '').replace(/^\[PATCH[^\]]*\]\s*/i, '').trim();
  return data(ref, parseUnifiedDiff(text), {title:subject || 'Pasted diff', baseOid:'',headOid:'',mergeBaseOid:'',baseRefName:'',headRefName:''});
}

export async function loadSource(ref: ReviewRef): Promise<PrData> {
  switch (ref.kind) {
    case 'commit': return loadCommit(ref);
    case 'compare': return loadCompare(ref);
    case 'local': return loadLocal(ref);
    case 'paste': return loadPaste(ref);
    case 'pr': throw new Error('Use loadPr for pull requests');
  }
}

export async function fetchLocalBlobs(repo: string, specs: BlobSpec[]): Promise<Map<string, BlobResult>> {
  const result = new Map<string, BlobResult>();
  for (let i = 0; i < specs.length; i += 200) {
    const batch = await local<Record<string, BlobResult>>('local/blobs', {method:'POST',body:{repo,specs:specs.slice(i, i + 200)}});
    for (const [key, value] of Object.entries(batch)) result.set(key, value);
  }
  return result;
}

export async function createPaste(diff: string): Promise<string> {
  return (await local<{id: string}>('paste', {method:'POST',body:{diff}})).id;
}
