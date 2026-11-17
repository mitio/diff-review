import type { PrData, PrFile, ReviewRef } from '../types';
import { afterEach, expect, test, vi } from 'vitest';
import { loadCommit, loadCompare, loadLocal, loadPaste, loadSource, fetchLocalBlobs, createPaste, contentOid, listFiles } from './sources';
const commit = {kind:'commit' as const,owner:'o',repo:'r',sha:'abcdef0'};
const compare = {kind:'compare' as const,owner:'o',repo:'r',base:'main',head:'feature/x'};
const patch = '@@ -1 +1 @@\n-old\n+new';
const diff = 'diff --git a/x b/x\nindex aaaaaaa..bbbbbbb 100644\n--- a/x\n+++ b/x\n'+patch+'\n';
const raw = (filename = 'x') => ({filename,status:'modified',sha:'b',additions:1,deletions:1,patch});
const meta = {sha:'b'.repeat(40),commit:{message:'Subject\n\nBody'},author:{login:'alice',avatar_url:'avatar'},parents:[{sha:'a'.repeat(40)}]};
afterEach(() => vi.unstubAllGlobals());
function mock(fn: (url: string, body: any) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    expect((init?.headers as Record<string,string>)['x-ghr']).toBe('1');
    return fn(url, init?.body ? JSON.parse(String(init.body)) : undefined);
  });
  vi.stubGlobal('fetch', fetcher); return fetcher;
}

test('commit follows next links, preserves REST order and metadata', async () => {
  const fetcher = mock(url => url.includes('page=2') ? Response.json({...meta, files:[raw('y')]}) : Response.json({...meta,files:[raw()]}, {headers:{link:'<https://api.github.com/repos/o/r/commits/abcdef0?per_page=100&page=2>; rel="next"'}}));
  const data = await loadCommit(commit);
  expect(data).toMatchObject({id:'o/r@abcdef0',title:'Subject',author:{login:'alice',avatarUrl:'avatar'},baseOid:'a'.repeat(40),mergeBaseOid:'a'.repeat(40),headOid:'b'.repeat(40),baseRefName:'aaaaaaa',headRefName:'bbbbbbb',viewer:{login:'you',avatarUrl:''},state:'',isDraft:false,threads:[],pendingReviewId:null,changedFiles:2,additions:2,deletions:2});
  expect(data.files.map(f => f.path)).toEqual(['x','y']);
  expect(data.files.every(f => !!f.fingerprint)).toBe(true);
  expect(fetcher.mock.calls[0][0]).toBe('/api/rest/repos/o/r/commits/abcdef0?per_page=100');
});

test('root commits use the empty tree; missing patches are filled with a diff by previous path', async () => {
  mock(url => url.startsWith('/api/diff/') ? new Response(diff) : Response.json({...meta,parents:[],author:null,files:[{...raw('new'),previous_filename:'x',patch:undefined}]}));
  const data = await loadCommit(commit);
  expect(data.baseOid).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  expect(data.author).toBeNull();
  expect(data.files[0]).toMatchObject({status:'added',patch});
});

test.each([false,true])('commit 3000 cap uses full diff, failure marks truncated (%s)', async fail => {
  mock(url => url.startsWith('/api/diff/') ? fail ? Response.json({message:'too large'}, {status:422}) : new Response(diff) : Response.json({...meta,files:Array.from({length:3000}, (_,i) => raw(String(i)))}));
  const data = await loadCommit(commit);
  expect(data.files).toHaveLength(fail ? 3000 : 1);
  expect(!!data.truncated).toBe(fail);
  expect(data.changedFiles).toBe(fail ? 3001 : 1);
});

test('commit pagination stops after 30 pages and falls back to diff', async () => {
  let pages = 0;
  mock(url => url.startsWith('/api/diff/') ? new Response(diff) : (pages++, Response.json({...meta,files:[raw(String(pages))]}, {headers:{link:`<https://api.github.com/repos/o/r/commits/abcdef0?page=${pages+1}>; rel="next"`}})));
  expect((await loadCommit(commit)).files.map(f => f.path)).toEqual(['x']);
  expect(pages).toBe(30);
});

function compareMock(files: any[], full: Response) {
  return mock((url, body) => {
    if (url === '/api/graphql') {
      expect(body.variables).toMatchObject({base:'main',head:'feature/x'});
      return Response.json({data:{repository:{base:{oid:'a'.repeat(40)},head:{oid:'b'.repeat(40)}}}});
    }
    if (url.startsWith('/api/diff/')) return full;
    expect(url).toBe(`/api/rest/repos/o/r/compare/${'a'.repeat(40)}...${'b'.repeat(40)}?per_page=1`);
    return Response.json({merge_base_commit:{sha:'merge'},files});
  });
}

test('compare resolves both refs together and uses merge base; fills missing patch', async () => {
  compareMock([{...raw(),patch:undefined}], new Response(diff));
  const data = await loadCompare(compare);
  expect(data).toMatchObject({id:'o/r@main...feature/x',title:'main...feature/x',baseRefName:'main',headRefName:'feature/x',baseOid:'a'.repeat(40),headOid:'b'.repeat(40),mergeBaseOid:'merge',author:null});
  expect(data.files[0].patch).toBe(patch);
});

test.each([false,true])('compare exact 300 cap falls back or marks truncated (%s)', async fail => {
  compareMock(Array.from({length:300}, (_,i) => raw(String(i))), fail ? Response.json({message:'timeout'}, {status:422}) : new Response(diff));
  const data = await loadCompare(compare);
  expect(data.files).toHaveLength(fail ? 300 : 1);
  expect(!!data.truncated).toBe(fail);
  expect(data.changedFiles).toBe(fail ? 301 : 1);
});

test('failed missing-patch fallback keeps uncapped REST files', async () => {
  compareMock([{...raw(),patch:undefined}], Response.json({message:'oops'}, {status:500}));
  const data = await loadCompare(compare);
  expect(data.files[0].patch).toBeUndefined();
  expect(data.truncated).toBeFalsy();
});

test('local and paste load through guarded API routes with source metadata', async () => {
  mock(url => url.startsWith('/api/local/diff?') ? Response.json({root:'/r',range:'',baseOid:'a'.repeat(40),headOid:'worktree:123',mergeBaseOid:'a'.repeat(40),title:'Uncommitted changes',author:{name:'Name'},diff}) : new Response('From abc\nSubject: [PATCH 1/2] Fix it\n\n'+diff));
  expect(await loadLocal({kind:'local',repo:'/r',range:''})).toMatchObject({title:'Uncommitted changes',baseRefName:'aaaaaaa',headRefName:'working tree',url:'',author:null});
  expect(await loadPaste({kind:'paste',id:'id'})).toMatchObject({id:'paste:id',title:'Fix it',baseOid:'',headOid:'',mergeBaseOid:'',url:''});
  mock(() => new Response(diff));
  expect((await loadSource({kind:'paste',id:'id'})).title).toBe('Pasted diff');
  await expect(loadSource({kind:'pr',owner:'o',repo:'r',number:1})).rejects.toThrow();
});

test('local blobs batch at 200 without caching, and paste creation returns id', async () => {
  const sizes: number[] = [];
  mock((url, body) => {
    if (url === '/api/paste') { expect(body).toEqual({diff}); return Response.json({id:'paste-id'}); }
    expect(url).toBe('/api/local/blobs'); expect(body.repo).toBe('/r'); sizes.push(body.specs.length);
    return Response.json(Object.fromEntries(body.specs.map((s: any) => [`${s.commit}:${s.path}`,{text:s.path,binary:false,truncated:false,missing:false}])));
  });
  const specs = Array.from({length:401}, (_,i) => ({commit:'worktree:123',path:String(i)}));
  expect((await fetchLocalBlobs('/r', specs)).get('worktree:123:400')?.text).toBe('400');
  await fetchLocalBlobs('/r', specs.slice(0,1));
  expect(sizes).toEqual([200,200,1,1]);
  expect(await createPaste(diff)).toBe('paste-id');
});

test('full diff fallback omits JSON pagination parameters', async () => {
  mock(url => {
    if (url.startsWith('/api/diff/')) {
      expect(url).toBe('/api/diff/repos/o/r/commits/abcdef0');
      return new Response(diff);
    }
    return Response.json({...meta,files:[{...raw(),patch:undefined}]});
  });
  expect((await loadCommit(commit)).files[0].patch).toBe(patch);
});

function review(ref: ReviewRef, files: PrFile[] = [], headOid = 'b'.repeat(40)): PrData {
  return {ref, files, headOid, baseOid:'a'.repeat(40), id:'test', title:'Test', url:'', state:'', isDraft:false,
    author:null, viewer:{login:'you',avatarUrl:''}, baseRefName:'base', headRefName:'head', mergeBaseOid:'a'.repeat(40),
    additions:0, deletions:0, changedFiles:files.length, threads:[], pendingReviewId:null};
}
const file = (path: string, status: PrFile['status'], previousPath?: string): PrFile =>
  ({path, status, previousPath, additions:0, deletions:0, viewed:'UNVIEWED'});

test('contentOid selects a full head oid or the local worktree base', () => {
  expect(contentOid(review(commit))).toBe('b'.repeat(40));
  expect(contentOid(review(commit, [], 'AB'.repeat(20)))).toBe('AB'.repeat(20));
  expect(contentOid(review(commit, [], 'abcdef0'))).toBeNull();
  expect(contentOid(review({kind:'local',repo:'/r',range:''}, [], 'worktree:123'))).toBe('a'.repeat(40));
  expect(contentOid(review({kind:'paste',id:'id'}, [], ''))).toBeNull();
});

test.each([commit, compare, {kind:'pr' as const,owner:'o',repo:'r',number:1}])('lists GitHub blobs at the head for $kind', async ref => {
  const fetcher = mock(() => Response.json({tree:[{path:'z',type:'blob'}, {path:'dir',type:'tree'},
    {path:'sub',type:'commit'}, {path:'a',type:'blob'}, {path:'z',type:'blob'}],truncated:true}));
  expect(await listFiles(review(ref))).toEqual({paths:['a','z'],truncated:true});
  expect(fetcher.mock.calls[0][0]).toBe(`/api/rest/repos/o/r/git/trees/${'b'.repeat(40)}?recursive=1`);
});

test.each(['worktree:123', 'b'.repeat(40)])('lists local files from the correct revision (%s)', async head => {
  const fetcher = mock(() => Response.json({paths:['old','removed','copy-source','unchanged','unchanged']}));
  const pr = review({kind:'local',repo:'/a repo',range:''}, [file('new','renamed','old'), file('removed','removed'),
    file('untracked','added'), file('copy','copied','copy-source'), file('unchanged','modified')], head);
  expect(await listFiles(pr)).toEqual({paths:['copy','copy-source','new','unchanged','untracked'],truncated:false});
  expect(fetcher.mock.calls[0][0]).toBe(`/api/local/files?repo=%2Fa%20repo&rev=${head.startsWith('worktree:') ? pr.baseOid : pr.headOid}`);
});

test('paste listing reconciles only diff paths in code-unit order', async () => {
  const fetcher = mock(() => { throw new Error('Unexpected request'); });
  const pr = review({kind:'paste',id:'id'}, [file('z','added'),file('A','modified'),file('a','copied','source'),
    file('gone','removed'),file('new','renamed','old'),file('z','modified')], '');
  expect(await listFiles(pr)).toEqual({paths:['A','a','new','z'],truncated:false});
  expect(fetcher).not.toHaveBeenCalled();
});
