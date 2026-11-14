import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { currentOids, parsePrUrl, fetchBlobs, setViewed, addThread, loadPr, refreshPr } from './github';
const ref = { owner: 'o', repo: 'r', number: 1 };
afterEach(() => vi.unstubAllGlobals());
function mock(handler: (query: string, variables: Record<string, any>, url: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const req = init?.body ? JSON.parse(init.body as string) : {};
    return Response.json(handler(req.query || '', req.variables || {}, String(url)));
  }));
}
test('PR URL formats reject foreign hosts and malformed numbers', () => {
  for (const s of ['https://github.com/o/r/pull/12/files?q=1#x', 'o/r/pull/12', 'o/r#12', 'http://127.0.0.1:7777/o/r/pull/12']) expect(parsePrUrl(s)).toEqual({ ...ref, number: 12 });
  for (const s of ['https://evil.com/o/r/pull/12', 'o/r#0', 'o/r/pull/1oops', 'https://github.com/o/r/issues/1']) expect(parsePrUrl(s)).toBeNull();
});
test('blobs batch at 40, preserve expressions and cache complete values', async () => {
  const sizes: number[] = [];
  mock((_q, vars) => {
    sizes.push(Object.keys(vars).filter(k => /^e\d+$/.test(k)).length);
    return { data: { repository: Object.fromEntries(Object.keys(vars).filter(k => /^e\d+$/.test(k)).map(k => [k.replace('e', 'b'), { text: vars[k], isBinary: false, isTruncated: false }])) } };
  });
  const specs = Array.from({length: 85}, (_, i) => ({ commit: 'sha', path: `p"\\雪${i}` }));
  const blobs = await fetchBlobs(ref, [...specs, specs[0]]);
  expect(sizes).toEqual([40,40,5]);
  expect(blobs.get('sha:p"\\雪0')?.text).toBe('sha:p"\\雪0');
  await fetchBlobs(ref, specs);
  expect(sizes).toHaveLength(3);
});
test('viewed reconciliation handles null and error aliases independently', async () => {
  mock(() => ({ data: { f0: {}, f1: null, f2: {} }, errors: [{ message:'no', path:['f2'] }] }));
  expect(await setViewed('pr', [0,1,2].map(n => ({ path:String(n), viewed:true })))).toEqual([{path:'0',ok:true},{path:'1',ok:false},{path:'2',ok:false}]);
});
test('null thread is an error', async () => {
  mock(() => ({ data: { addPullRequestReviewThread: { thread:null } } }));
  await expect(addThread('r', {path:'a',body:'b',subjectType:'LINE',line:1,side:'RIGHT'})).rejects.toThrow();
});
const page = { nodes: [], pageInfo: {hasNextPage:false,endCursor:null as string | null} };
function pr(head: string) { return {id:'pr',title:'title',url:'url',state:'OPEN',isDraft:false,author:null,baseRefName:'main',headRefName:'feature',baseRefOid:'base',headRefOid:head,changedFiles:1,additions:1,deletions:0,files:{...page,nodes:[{path:'a',viewerViewedState:'VIEWED'}]},reviewThreads:page,reviews:page}; }
test('currentOids reads base and head', async () => {
  mock(() => ({data:{repository:{pullRequest:{baseRefOid:'base',headRefOid:'new'}}}}));
  expect(await currentOids(ref)).toEqual({baseOid:'base',headOid:'new'});
});
test('refresh refuses changed snapshots', async () => {
  mock(() => ({data:{viewer:{login:'me'},repository:{pullRequest:pr('new')}}}));
  expect(await refreshPr(ref,{baseOid:'base',headOid:'old'})).toEqual({changed:true,baseOid:'base',headOid:'new'});
});
test('load paginates files and threads, drains nested comments, preserves REST order and mapping', async () => {
  const rawComment = {id:'c',author:null,pullRequestReview:{id:'review'},body:'text'};
  const rawThread = {id:'t',path:'b',diffSide:'LEFT',startDiffSide:'RIGHT',comments:{nodes:[rawComment],pageInfo:{hasNextPage:true,endCursor:'c1'}}};
  mock((q,v,url) => {
    if (url.includes('/files?')) return [{filename:'b',previous_filename:'old',status:'renamed',additions:2,deletions:1},{filename:'a',status:'modified',additions:1,deletions:1}];
    if (url.includes('/compare/')) return {merge_base_commit:{sha:'merge'}};
    if (q.includes('node(id:')) return {data:{node:{comments:{nodes:[{...rawComment,id:'c2'}],pageInfo:{hasNextPage:false}}}}};
    if (v.filesAfter) return {data:{repository:{pullRequest:{files:{nodes:[{path:'b',viewerViewedState:'DISMISSED'}],pageInfo:{hasNextPage:false}}}}}};
    if (v.threadsAfter) return {data:{repository:{pullRequest:{reviewThreads:{nodes:[rawThread],pageInfo:{hasNextPage:false}}}}}};
    if (!q.includes('changedFiles')) return {data:{repository:{pullRequest:{baseRefOid:'base',headRefOid:'head'}}}};
    const p = pr('head'); p.files.pageInfo = {hasNextPage:true,endCursor:'f1'}; p.reviewThreads = {nodes:[],pageInfo:{hasNextPage:true,endCursor:'t1'}};
    p.reviews = {...page,nodes:[{id:'other',author:{login:'someone'}},{id:'mine',author:{login:'me'}}]} as any;
    return {data:{viewer:{login:'me',avatarUrl:''},repository:{pullRequest:p}}};
  });
  const data = await loadPr(ref);
  expect(data.files.map(f => [f.path,f.previousPath,f.viewed])).toEqual([['b','old','DISMISSED'],['a',undefined,'VIEWED']]);
  expect(data.pendingReviewId).toBe('mine'); expect(data.author).toBeNull();
  expect(data.threads[0]).toMatchObject({side:'LEFT',startSide:'RIGHT',comments:[{id:'c',author:null,reviewId:'review'},{id:'c2',reviewId:'review'}]});
});
test('blob results missing or truncated are not cached', async () => {
  let count=0;
  mock(() => { count++; return {data:{repository:{b0:null,b1:{text:'partial',isTruncated:true,isBinary:false}}}}; });
  const specs = [{commit:'not-cached',path:'missing'},{commit:'not-cached',path:'large'}];
  const data = await fetchBlobs(ref,specs);
  expect(data.get('not-cached:missing')?.missing).toBe(true);
  expect(data.get('not-cached:large')?.truncated).toBe(true);
  await fetchBlobs(ref,specs); expect(count).toBe(2);
});
test('viewed chunks never exceed fifty and failed requests reconcile false', async () => {
  const sizes: number[] = [];
  mock((_q,v) => { sizes.push(Object.keys(v).length-1); return {message:'bad',errors:[{message:'failure'}],data:null}; });
  const results = await setViewed('pr',Array.from({length:101},(_,i)=>({path:String(i),viewed:false})));
  expect(sizes).toEqual([50,50,1]); expect(results.every(r=>!r.ok)).toBe(true);
});
test('writes send contract inputs, map returned comments and recover existing pending review',async()=>{
  const {ensurePendingReview, replyThread, updateComment, deleteComment, resolveThread, submitReview, discardReview} = await import('./github');
  const seen: Array<{q:string;v:Record<string,any>}> = [];
  mock((q,v)=>{
    seen.push({q,v});
    if(q.includes('addPullRequestReview(input:')) return {errors:[{message:'You already have a pending review'}]};
    if(q.includes('node(id:')) return {data:{viewer:{login:'me'},node:{reviews:{nodes:[{id:'pending',author:{login:'me'}}]}}}};
    const c={id:'comment',author:null,pullRequestReview:{id:'pending'}};
    if(q.includes('addPullRequestReviewThreadReply')) return {data:{addPullRequestReviewThreadReply:{comment:c}}};
    if(q.includes('updatePullRequestReviewComment')) return {data:{updatePullRequestReviewComment:{pullRequestReviewComment:c}}};
    if(q.includes('addPullRequestReviewThread')) return {data:{addPullRequestReviewThread:{thread:{id:'t',diffSide:'RIGHT',comments:page}}}};
    return {data:{}};
  });
  expect(await ensurePendingReview({id:'pr',headOid:'sha',pendingReviewId:'existing'})).toBe('existing');
  expect(seen).toHaveLength(0);
  expect(await ensurePendingReview({id:'pr',headOid:'sha',pendingReviewId:null})).toBe('pending');
  expect(await replyThread('pending','thread','body')).toMatchObject({id:'comment',reviewId:'pending',author:null});
  expect(await updateComment('comment','new')).toMatchObject({id:'comment',reviewId:'pending'});
  await addThread('pending',{path:'a',body:'file',subjectType:'FILE',line:5,side:'LEFT'});
  const input=seen.find(s=>s.q.includes('addPullRequestReviewThread(input:'))!.v.input;
  expect(input).toEqual({pullRequestReviewId:'pending',path:'a',body:'file',subjectType:'FILE'});
  await deleteComment('comment'); await resolveThread('thread',true); await resolveThread('thread',false); await submitReview('pending','APPROVE','done'); await discardReview('pending');
  expect(seen.find(s=>s.q.includes('submitPullRequestReview'))!.v.input).toEqual({pullRequestReviewId:'pending',event:'APPROVE',body:'done'});
});
