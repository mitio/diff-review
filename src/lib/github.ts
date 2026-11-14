import type { BlobResult, BlobSpec, Comment, NewThread, PrData, PrFile, PrRef, RefreshResult, ReviewEvent, Thread, ViewedState } from '../types';
import { gql, rest, restText } from './api';
import { splitUnifiedDiff } from './diff';
import * as cache from './cache';

const PAGE = 'pageInfo { hasNextPage endCursor }';
const COMMENT = 'id databaseId body bodyHTML createdAt author { login avatarUrl } state url viewerCanUpdate viewerCanDelete pullRequestReview { id }';
const THREAD = `id path line startLine originalLine diffSide startDiffSide isResolved isOutdated subjectType viewerCanResolve viewerCanUnresolve viewerCanReply comments(first:100) { nodes { ${COMMENT} } ${PAGE} }`;
const CONNECTIONS = `files(first:100, after:$filesAfter) { nodes { path additions deletions viewerViewedState } ${PAGE} } reviewThreads(first:100, after:$threadsAfter) { nodes { ${THREAD} } ${PAGE} } reviews(states:PENDING,first:20) { nodes { id author { login } } }`;
const META = 'id number title url state isDraft author { login avatarUrl } baseRefName headRefName baseRefOid headRefOid changedFiles additions deletions';
const PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$filesAfter:String,$threadsAfter:String) { viewer { login avatarUrl } repository(owner:$owner,name:$repo) { pullRequest(number:$number) { ${META} ${CONNECTIONS} } } }`;
type Raw = Record<string, any>;
const vars = (ref: PrRef) => ({owner:ref.owner,repo:ref.repo,number:ref.number});
function comment(c: Raw): Comment {
  const {pullRequestReview, ...fields} = c;
  return {...fields,author:c.author ?? null, ...(pullRequestReview?.id ? {reviewId:pullRequestReview.id} : {})} as Comment;
}
function thread(t: Raw): Thread {
  const {diffSide,startDiffSide,comments,...fields} = t;
  return {...fields,side:diffSide,startSide:startDiffSide ?? null,comments:comments.nodes.map(comment)} as Thread;
}
export function parsePrUrl(s: string): PrRef | null {
  s = s.trim();
  if (/^https?:\/\//.test(s)) {
    try { const u = new URL(s); if (!(u.origin === 'https://github.com' || u.origin === 'http://127.0.0.1:7777')) return null; s = u.pathname.replace(/^\//,''); } catch { return null; }
  }
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/pull\/([1-9]\d*)(?=$|[/?#])|#([1-9]\d*)$)/.exec(s);
  if (!m) return null;
  const number = Number(m[3] || m[4]);
  return Number.isSafeInteger(number) ? {owner:m[1],repo:m[2],number} : null;
}
async function drainComments(t: Raw): Promise<void> {
  let info = t.comments.pageInfo;
  while (info?.hasNextPage) {
    const {data} = await gql<Raw>(`query($id:ID!,$after:String) { node(id:$id) { ... on PullRequestReviewThread { comments(first:100,after:$after) { nodes { ${COMMENT} } ${PAGE} } } } }`,{id:t.id,after:info.endCursor});
    if (!data.node) throw new Error('Review thread disappeared while loading');
    const next = data.node.comments;
    t.comments.nodes.push(...next.nodes); info = next.pageInfo;
  }
}
async function paginate(ref: PrRef, pr: Raw): Promise<void> {
  await Promise.all([['files','filesAfter'],['reviewThreads','threadsAfter']].map(async ([name,after]) => {
    let info = pr[name].pageInfo;
    while (info?.hasNextPage) {
      const field = name === 'files' ? 'path additions deletions viewerViewedState' : THREAD;
      const {data:next} = await gql<Raw>(`query($owner:String!,$repo:String!,$number:Int!,$${after}:String) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) { ${name}(first:100,after:$${after}) { nodes { ${field} } ${PAGE} } } } }`,{...vars(ref),[after]:info.endCursor});
      const connection = next.repository.pullRequest[name];
      pr[name].nodes.push(...connection.nodes); info = connection.pageInfo;
    }
  }));
  await Promise.all(pr.reviewThreads.nodes.map(drainComments));
}
async function firstPage(ref: PrRef): Promise<{pr:Raw; viewer:PrData['viewer']}> {
  const {data} = await gql<Raw>(PR_QUERY,vars(ref));
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error('Pull request not found');
  return {pr,viewer:data.viewer};
}
async function snapshot(ref: PrRef, known?: {baseOid:string;headOid:string}): Promise<{pr:Raw; viewer:PrData['viewer']; changed:boolean}> {
  const {pr,viewer} = await firstPage(ref);
  if (known && (known.baseOid !== pr.baseRefOid || known.headOid !== pr.headRefOid)) return {pr,viewer,changed:true};
  await paginate(ref,pr);
  return {pr,viewer,changed:false};
}
/** Cheap consistency check; callers compare against the oids a load was built from. */
export async function currentOids(ref: PrRef): Promise<{baseOid:string;headOid:string}> {
  const {data} = await gql<Raw>('query($owner:String!,$repo:String!,$number:Int!) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) { baseRefOid headRefOid } } }',vars(ref));
  const pr = data.repository.pullRequest;
  return {baseOid:pr.baseRefOid,headOid:pr.headRefOid};
}
function pending(pr: Raw, login: string): string | null { return pr.reviews.nodes.find((r: Raw) => r.author?.login === login)?.id ?? null; }
const sameOids = (a: {baseOid:string;headOid:string}, b: {baseOid:string;headOid:string}) => a.baseOid === b.baseOid && a.headOid === b.headOid;
/**
 * REST and GraphQL reads are not atomic. The REST file list starts strictly after an oid read that must match the
 * GraphQL snapshot; callers must still compare currentOids() afterwards (a later push => "PR changed").
 */
export async function loadPr(ref: PrRef): Promise<PrData> {
  const prefix = `repos/${ref.owner}/${ref.repo}`;
  const filesUrl = (page: number) => `${prefix}/pulls/${ref.number}/files?per_page=100&page=${page}`;
  for (let attempt = 0; ; attempt++) {
    const firstP = firstPage(ref);
    firstP.catch(() => {});
    const before = await currentOids(ref);
    const restP = rest<Raw[]>(filesUrl(1)).then(async first => {
      const last = Number(/[?&]page=(\d+)>; rel="last"/.exec(first.link ?? '')?.[1] ?? 1);
      const more = await Promise.all(Array.from({length:Math.max(0,Math.min(30,last)-1)},(_,i) => rest<Raw[]>(filesUrl(i+2))));
      return [first,...more].flatMap(p => p.data);
    });
    restP.catch(() => {});
    const {pr,viewer} = await firstP;
    if (!sameOids(before,{baseOid:pr.baseRefOid,headOid:pr.headRefOid})) {
      if (attempt < 2) continue;
      throw new Error('PR kept changing while loading; reload');
    }
    const [, rawFiles, compare] = await Promise.all([
      paginate(ref,pr),
      restP,
      rest<Raw>(`${prefix}/compare/${pr.baseRefOid}...${pr.headRefOid}?per_page=1`),
    ]);
    const viewed = new Map<string,ViewedState>(pr.files.nodes.map((f: Raw) => [f.path,f.viewerViewedState]));
    const counts = new Map<string,Raw>(pr.files.nodes.map((f: Raw) => [f.path,f]));
    const files: PrFile[] = rawFiles.map(f => ({path:f.filename,...(f.previous_filename ? {previousPath:f.previous_filename}:{}),status:f.status,additions:counts.get(f.filename)?.additions ?? f.additions,deletions:counts.get(f.filename)?.deletions ?? f.deletions,...(f.patch !== undefined ? {patch:f.patch}:{}),viewed:viewed.get(f.filename) ?? 'UNVIEWED'}));
    return {ref,id:pr.id,title:pr.title,url:pr.url,state:pr.state,isDraft:pr.isDraft,author:pr.author ?? null,viewer,baseRefName:pr.baseRefName,headRefName:pr.headRefName,baseOid:pr.baseRefOid,headOid:pr.headRefOid,mergeBaseOid:compare.data.merge_base_commit.sha,additions:pr.additions,deletions:pr.deletions,changedFiles:pr.changedFiles,files,threads:pr.reviewThreads.nodes.map(thread),pendingReviewId:pending(pr,viewer.login)};
  }
}
export async function refreshPr(ref: PrRef, known: {baseOid:string;headOid:string}): Promise<RefreshResult> {
  const {pr,viewer,changed} = await snapshot(ref,known);
  if (changed) return {changed:true,baseOid:pr.baseRefOid,headOid:pr.headRefOid};
  const after = await currentOids(ref);
  if (!sameOids(after,known)) return {changed:true,...after};
  return {changed:false,threads:pr.reviewThreads.nodes.map(thread),viewed:Object.fromEntries(pr.files.nodes.map((f: Raw) => [f.path,f.viewerViewedState])),pendingReviewId:pending(pr,viewer.login)};
}
export async function fetchBlobs(ref: PrRef, specs: BlobSpec[]): Promise<Map<string,BlobResult>> {
  const unique = [...new Map(specs.map(s => [`${s.commit}:${s.path}`,s])).entries()];
  const prefix = `${ref.owner}/${ref.repo}/`;
  const cached = await cache.getMany(unique.map(([key]) => prefix+key));
  const result = new Map<string,BlobResult>();
  const missing = unique.filter(([key]) => { const value = cached.get(prefix+key); if (value) result.set(key,value); return !value; });
  const batches = Array.from({length:Math.ceil(missing.length/40)},(_,i) => missing.slice(i*40,i*40+40));
  for (let i=0;i<batches.length;i+=4) await Promise.all(batches.slice(i,i+4).map(async batch => {
    const variables: Raw = {owner:ref.owner,repo:ref.repo};
    batch.forEach(([key],j) => { variables[`e${j}`] = key; });
    const declarations = batch.map((_,j) => `$e${j}:String!`).join(',');
    const fields = batch.map((_,j) => `b${j}:object(expression:$e${j}) { ... on Blob { text isBinary isTruncated } }`).join(' ');
    const {data} = await gql<Raw>(`query($owner:String!,$repo:String!,${declarations}) { repository(owner:$owner,name:$repo) { ${fields} } }`,variables);
    const save: Array<[string,BlobResult]> = [];
    batch.forEach(([key],j) => {
      const b = data.repository?.[`b${j}`];
      const value: BlobResult = !b || !('isBinary' in b) ? {text:null,binary:false,truncated:false,missing:true} : {text:b.text,binary:b.isBinary,truncated:b.isTruncated,missing:false};
      result.set(key,value); if (!value.missing && !value.truncated) save.push([prefix+key,value]);
    });
    await cache.putMany(save);
  }));
  return result;
}
export async function setViewed(prId: string, items: {path:string;viewed:boolean}[]): Promise<Array<{path:string;ok:boolean}>> {
  const result: Array<{path:string;ok:boolean}> = [];
  for (let i=0;i<items.length;i+=50) {
    const batch = items.slice(i,i+50); const variables: Raw = {p:prId};
    batch.forEach((item,j) => { variables[`p${j}`] = item.path; });
    try {
      const {data,errors} = await gql<Raw>(`mutation($p:ID!,${batch.map((_,j) => `$p${j}:String!`).join(',')}) { ${batch.map((item,j) => `f${j}:${item.viewed?'markFileAsViewed':'unmarkFileAsViewed'}(input:{pullRequestId:$p,path:$p${j}}) { clientMutationId }`).join(' ')} }`,variables,{allowPartial:true});
      batch.forEach((item,j) => result.push({path:item.path,ok:data?.[`f${j}`] != null && !errors?.some(e => !e.path?.length || e.path[0] === `f${j}`)}));
    } catch { result.push(...batch.map(item => ({path:item.path,ok:false}))); }
  }
  return result;
}
export async function ensurePendingReview(pr: {id:string;headOid:string;pendingReviewId:string|null}): Promise<string> {
  if (pr.pendingReviewId) return pr.pendingReviewId;
  try {
    const {data} = await gql<Raw>('mutation($p:ID!,$head:GitObjectID!) { addPullRequestReview(input:{pullRequestId:$p,commitOID:$head}) { pullRequestReview { id } } }',{p:pr.id,head:pr.headOid});
    return data.addPullRequestReview.pullRequestReview.id;
  } catch (error) {
    if (!/pending review|review.*pending/i.test(String(error))) throw error;
    const {data} = await gql<Raw>('query($id:ID!) { viewer { login } node(id:$id) { ... on PullRequest { reviews(states:PENDING,first:20) { nodes { id author { login } } } } } }',{id:pr.id});
    const id = pending(data.node,data.viewer.login); if (id) return id; throw error;
  }
}
export async function addThread(reviewId: string, t: NewThread): Promise<Thread> {
  const input: Raw = {pullRequestReviewId:reviewId,path:t.path,body:t.body,subjectType:t.subjectType};
  if (t.subjectType === 'LINE') for (const key of ['line','side','startLine','startSide'] as const) if (t[key] !== undefined) input[key] = t[key];
  const {data} = await gql<Raw>(`mutation($input:AddPullRequestReviewThreadInput!) { addPullRequestReviewThread(input:$input) { thread { ${THREAD} } } }`,{input});
  const raw = data.addPullRequestReviewThread.thread;
  if (!raw) throw new Error('GitHub rejected the comment line; use a file comment instead');
  await drainComments(raw); return thread(raw);
}
export async function replyThread(reviewId: string, threadId: string, body: string): Promise<Comment> {
  const {data} = await gql<Raw>(`mutation($input:AddPullRequestReviewThreadReplyInput!) { addPullRequestReviewThreadReply(input:$input) { comment { ${COMMENT} } } }`,{input:{pullRequestReviewId:reviewId,pullRequestReviewThreadId:threadId,body}});
  return comment(data.addPullRequestReviewThreadReply.comment);
}
export async function updateComment(id: string, body: string): Promise<Comment> {
  const {data} = await gql<Raw>(`mutation($input:UpdatePullRequestReviewCommentInput!) { updatePullRequestReviewComment(input:$input) { pullRequestReviewComment { ${COMMENT} } } }`,{input:{pullRequestReviewCommentId:id,body}});
  return comment(data.updatePullRequestReviewComment.pullRequestReviewComment);
}
export async function deleteComment(id: string): Promise<void> { await gql('mutation($id:ID!) { deletePullRequestReviewComment(input:{id:$id}) { clientMutationId } }',{id}); }
export async function resolveThread(id: string, resolved: boolean): Promise<void> { await gql(`mutation($id:ID!) { ${resolved?'resolveReviewThread':'unresolveReviewThread'}(input:{threadId:$id}) { clientMutationId } }`,{id}); }
export async function submitReview(reviewId: string, event: ReviewEvent, body: string): Promise<void> { await gql('mutation($input:SubmitPullRequestReviewInput!) { submitPullRequestReview(input:$input) { clientMutationId } }',{input:{pullRequestReviewId:reviewId,event,body}}); }
export async function discardReview(reviewId: string): Promise<void> { await gql('mutation($id:ID!) { deletePullRequestReview(input:{pullRequestReviewId:$id}) { clientMutationId } }',{id:reviewId}); }
/** GitHub's whole-PR diff, split per file. Fills in patches the REST file list omits on large PRs. */
export async function fetchPatches(ref: PrRef): Promise<Map<string,string>> {
  return splitUnifiedDiff(await restText(`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`));
}
