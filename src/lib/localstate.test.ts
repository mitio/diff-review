import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReviewDoc } from '../types';
import { LocalReview, toThreads, viewedStates } from './localstate';
const ref = {kind:'paste' as const,id:'test'};
const empty = (): ReviewDoc => ({key:'paste:test',ref,title:'title',version:0,updatedAt:'2026-01-01T00:00:00.000Z',viewed:{},threads:[]});
const input = {path:'x',body:'first',subjectType:'LINE' as const,line:2,side:'RIGHT' as const,quote:[{kind:'ctx' as const,text:'text'}]};
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function server(initial: ReviewDoc | null = null) {
  let stored = initial;
  const writes: Array<{doc:ReviewDoc;baseVersion:number}> = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    expect((init?.headers as Record<string,string>)['x-ghr']).toBe('1');
    if (init?.method !== 'PUT') return stored ? Response.json(stored) : Response.json({message:'missing'}, {status:404});
    const body = JSON.parse(String(init.body)); writes.push(body);
    stored = {...body.doc,version:(stored?.version ?? 0)+1};
    return Response.json({version:stored!.version});
  });
  vi.stubGlobal('fetch', fetcher);
  return {writes,fetcher};
}

test('new docs apply ordered operations optimistically and coalesce after 300ms', async () => {
  const {writes} = server();
  const review = await LocalReview.open(ref,'title');
  expect(review.doc()).toMatchObject({key:'paste:test',version:0,title:'title',viewed:{},threads:[]});
  const first = review.addThread(input);
  const id = review.doc().threads[0].id;
  const reply = review.reply(id,'reply');
  let settled = false; void first.then(() => {settled=true;});
  expect(review.doc().threads[0].comments.map(c => c.body)).toEqual(['first','reply']);
  await vi.advanceTimersByTimeAsync(299);
  expect(writes).toHaveLength(0); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(writes).toHaveLength(1);
  expect(writes[0].baseVersion).toBe(0);
  expect((await first).id).toBe(id); expect((await reply).body).toBe('reply');
  expect(review.doc().version).toBe(1);
  await review.flush();
});

test('flush drains edits, resolve, deletion and viewed intents with acknowledged versions', async () => {
  const {writes} = server();
  const review = await LocalReview.open(ref,'title');
  const adding = review.addThread(input); await review.flush(); const t = await adding;
  const editing = review.edit(t.comments[0].id,'updated');
  const resolving = review.resolve(t.id,true);
  const viewing = review.setViewed([{path:'x',fingerprint:'displayed'},{path:'y',fingerprint:'other'}]);
  await review.flush();
  expect(await editing).toMatchObject({body:'updated',updatedAt:expect.any(String)}); await resolving; await viewing;
  expect(review.doc()).toMatchObject({version:2,viewed:{x:'displayed',y:'other'},threads:[{resolved:true}]});
  const deleting = review.remove(t.comments[0].id);
  const unmark = review.setViewed([{path:'x',fingerprint:null}]);
  await review.flush(); await deleting; await unmark;
  expect(review.doc()).toMatchObject({threads:[],viewed:{y:'other'}});
  expect(writes.map(w => w.baseVersion)).toEqual([0,1,2]);
});

test('ops during a PUT wait for the next PUT and settle separately', async () => {
  let finish!: (response: Response) => void;
  const requests: any[] = [];
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'PUT') return Response.json(empty());
    requests.push(JSON.parse(String(init.body)));
    if (requests.length === 1) return new Promise<Response>(resolve => {finish=resolve;});
    return Response.json({version:2});
  });
  const review = await LocalReview.open(ref,'title');
  const first = review.addThread(input); let secondSettled = false;
  await vi.advanceTimersByTimeAsync(300);
  const second = review.reply(review.doc().threads[0].id,'next'); void second.then(() => {secondSettled=true;});
  await vi.advanceTimersByTimeAsync(300); expect(requests).toHaveLength(1);
  finish(Response.json({version:1})); await first;
  expect(secondSettled).toBe(false);
  await review.flush(); await second;
  expect(requests[0].doc.threads[0].comments).toHaveLength(1);
  expect(requests[1].doc.threads[0].comments).toHaveLength(2);
  expect(requests[1].baseVersion).toBe(1);
});

test.each([409,500])('failed PUT %s drops all ops, refetches and replaces state', async status => {
  let reads = 0;
  const external = {...empty(),version:7,title:'elsewhere',viewed:{remote:'fp'}};
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'PUT') return Response.json(++reads === 1 ? empty() : external);
    return new Promise<Response>(resolve => {finish=resolve;});
  });
  const review = await LocalReview.open(ref,'title'); const replaced = vi.fn();
  const unsubscribe = review.onReplace(replaced);
  const first = review.addThread(input); const rejected = expect(first).rejects.toThrow(status === 409 ? 'Changed elsewhere; reloaded' : 'Save failed: broken');
  await vi.advanceTimersByTimeAsync(300);
  const second = review.setViewed([{path:'x',fingerprint:'fp'}]); const rejected2 = expect(second).rejects.toThrow();
  const flushing = review.flush(); const rejectedFlush = expect(flushing).rejects.toThrow();
  finish(Response.json(status === 409 ? {doc:external} : {message:'broken'}, {status}));
  await rejected; await rejected2; await rejectedFlush;
  expect(reads).toBe(2);
  expect(review.doc()).toEqual(external);
  expect(replaced).toHaveBeenCalledWith(external, status === 409 ? 'Changed elsewhere; reloaded' : 'Save failed: broken');
  unsubscribe();
});

test('unknown references reject immediately without saving; callers cannot mutate the doc', async () => {
  const {writes} = server(); const review = await LocalReview.open(ref,'title');
  await expect(review.reply('missing','x')).rejects.toThrow('Unknown thread');
  await expect(review.resolve('missing',true)).rejects.toThrow('Unknown thread');
  await expect(review.edit('missing','x')).rejects.toThrow('Unknown comment');
  await expect(review.remove('missing')).rejects.toThrow('Unknown comment');
  review.doc().viewed.x = 'accidental';
  expect(review.doc().viewed).toEqual({});
  await review.flush(); expect(writes).toHaveLength(0);
});

test('outdated flags and titles skip unchanged values and persist changes', async () => {
  const {writes} = server(); const review = await LocalReview.open(ref,'title');
  review.setTitle('title'); review.setOutdated({}); await review.flush(); expect(writes).toHaveLength(0);
  const adding = review.addThread(input); await review.flush(); const t = await adding;
  review.setOutdated({[t.id]:false}); review.setTitle('title'); await review.flush(); expect(writes).toHaveLength(1);
  review.setOutdated({[t.id]:true}); review.setTitle('new title'); await review.flush();
  expect(review.doc()).toMatchObject({title:'new title',threads:[{outdated:true}]});
  expect(writes).toHaveLength(2);
});

test('mapping preserves local ids, permissions, quotes and fingerprint viewed states', async () => {
  server(); const review = await LocalReview.open(ref,'title'); const adding = review.addThread(input); await review.flush(); const t = await adding;
  const doc = review.doc(); doc.threads[0].outdated = true; doc.viewed = {x:'same',y:'old'};
  const viewer = {login:'you',avatarUrl:''};
  expect(toThreads(doc,viewer)[0]).toMatchObject({id:t.id,quote:input.quote,isOutdated:true,isResolved:false,originalLine:null,viewerCanResolve:true,viewerCanUnresolve:false,viewerCanReply:true,comments:[{id:t.comments[0].id,state:'LOCAL',author:viewer,bodyHTML:'',url:'',viewerCanUpdate:true,viewerCanDelete:true}]});
  doc.threads[0].resolved = true;
  expect(toThreads(doc,viewer)[0]).toMatchObject({viewerCanResolve:false,viewerCanUnresolve:true});
  const f = {status:'modified' as const,additions:0,deletions:0,viewed:'UNVIEWED' as const};
  expect(viewedStates(doc,[{...f,path:'x',fingerprint:'same'},{...f,path:'y',fingerprint:'changed'},{...f,path:'z',fingerprint:'new'}])).toEqual({x:'VIEWED',y:'DISMISSED',z:'UNVIEWED'});
});

test('viewed intents preserve valid git paths that also name object properties', async () => {
  server(); const review = await LocalReview.open(ref,'title');
  const saving = review.setViewed([{path:'__proto__',fingerprint:'fp'}]);
  await review.flush(); await saving;
  expect(Object.hasOwn(review.doc().viewed,'__proto__')).toBe(true);
  expect(review.doc().viewed['__proto__']).toBe('fp');
});

test('a new review is not saved until something is written, then carries the title', async () => {
  const calls: Array<{method: string; body?: any}> = [];
  globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push({method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined});
    if (!init?.method) return new Response(JSON.stringify({message: 'State not found'}), {status: 404});
    return new Response(JSON.stringify({version: 1}), {status: 200});
  }) as typeof fetch;
  const review = await LocalReview.open({kind: 'paste', id: 'a'.repeat(64)}, '');
  review.setTitle('Pasted diff');
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls.map(c => c.method)).toEqual(['GET']);
  const done = review.setViewed([{path: 'x', fingerprint: 'f'}]);
  await vi.advanceTimersByTimeAsync(400);
  await done;
  expect(calls.map(c => c.method)).toEqual(['GET', 'PUT']);
  expect(calls[1].body.doc.title).toBe('Pasted diff');
});

test('reload only moves forward and never while writes are pending', async () => {
  let stored: any = {key: 'paste:' + 'b'.repeat(64), ref: {kind: 'paste', id: 'b'.repeat(64)}, title: 't', version: 2, updatedAt: '', viewed: {}, threads: []};
  globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { stored = {...JSON.parse(String(init.body)).doc, version: stored.version + 1}; return new Response(JSON.stringify({version: stored.version}), {status: 200}); }
    return new Response(JSON.stringify(stored), {status: 200});
  }) as typeof fetch;
  const review = await LocalReview.open({kind: 'paste', id: 'b'.repeat(64)}, '');
  expect(await review.reload()).toBe(false);
  stored = {...stored, version: 1, title: 'older'};
  expect(await review.reload()).toBe(false);
  expect(review.doc().title).toBe('t');
  stored = {...stored, version: 5, title: 'newer'};
  void review.setViewed([{path: 'x', fingerprint: 'f'}]);
  expect(await review.reload()).toBe(false);
  await vi.advanceTimersByTimeAsync(400);
  await review.flush();
  expect(review.doc().version).toBe(6);
});
