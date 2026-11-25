import type { BlobResult, Reaction, ReactionContent, BlobSpec, Check, CheckBucket, Checks, Comment, Conversation, IssueComment, NewThread, PrData, PrFile, PrRef, RecentStatus, RefreshResult, ReviewEvent, ReviewSummary, Thread, ViewedState } from '../types';
import { gql, rest, restText } from './api';
import { splitUnifiedDiff } from './diff';
import * as cache from './cache';

const PAGE = 'pageInfo { hasNextPage endCursor }';
/** counts only: reactor lists would multiply the node count of a whole PR */
const REACTIONS = 'viewerCanReact reactionGroups { content viewerHasReacted reactors { totalCount } }';
const COMMENT = `id databaseId body bodyHTML createdAt author { login avatarUrl } state url viewerCanUpdate viewerCanDelete pullRequestReview { id } ${REACTIONS}`;
const THREAD = `id path line startLine originalLine diffSide startDiffSide isResolved isOutdated subjectType viewerCanResolve viewerCanUnresolve viewerCanReply comments(first:100) { nodes { ${COMMENT} } ${PAGE} }`;
const CONNECTIONS = `files(first:100, after:$filesAfter) { nodes { path additions deletions viewerViewedState } ${PAGE} } reviewThreads(first:100, after:$threadsAfter) { nodes { ${THREAD} } ${PAGE} } reviews(states:PENDING,first:20) { nodes { id author { login } } }`;
const META = 'id number title url state isDraft author { login avatarUrl } baseRefName headRefName baseRefOid headRefOid changedFiles additions deletions';
const PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$filesAfter:String,$threadsAfter:String) { viewer { login avatarUrl } repository(owner:$owner,name:$repo) { pullRequest(number:$number) { ${META} ${CONNECTIONS} } } }`;
type Raw = Record<string, any>;
const vars = (ref: PrRef) => ({owner:ref.owner,repo:ref.repo,number:ref.number});
function reactions(groups: Raw[] | null | undefined): Reaction[] {
  return (groups ?? []).filter(g => g.reactors.totalCount > 0).map(g => ({content:g.content,count:g.reactors.totalCount,viewerHasReacted:g.viewerHasReacted}));
}
/** GitHub takes no reactions on pending comments. */
const reactable = ({reactionGroups, viewerCanReact}: Raw, pending = false) => (pending ? {} : {reactions:reactions(reactionGroups),canReact:!!viewerCanReact});
function comment(c: Raw): Comment {
  const {pullRequestReview, reactionGroups, viewerCanReact, ...fields} = c;
  return {...fields,author:c.author ?? null, ...(pullRequestReview?.id ? {reviewId:pullRequestReview.id} : {}), ...reactable(c, c.state === 'PENDING')} as Comment;
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
    return {ref:{kind:"pr",...ref},id:pr.id,title:pr.title,url:pr.url,state:pr.state,isDraft:pr.isDraft,author:pr.author ?? null,viewer,baseRefName:pr.baseRefName,headRefName:pr.headRefName,baseOid:pr.baseRefOid,headOid:pr.headRefOid,mergeBaseOid:compare.data.merge_base_commit.sha,additions:pr.additions,deletions:pr.deletions,changedFiles:pr.changedFiles,files,threads:pr.reviewThreads.nodes.map(thread),pendingReviewId:pending(pr,viewer.login)};
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

const CONTEXTS = `contexts(first:100, after:$after) { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } nodes { __typename ... on CheckRun { name status conclusion detailsUrl startedAt completedAt isRequired(pullRequestNumber:$number) checkSuite { app { name } workflowRun { workflow { name } } } } ... on StatusContext { context state targetUrl description createdAt isRequired(pullRequestNumber:$number) } } ${PAGE} }`;
const RUN_PENDING = new Set(['IN_PROGRESS','PENDING','QUEUED','WAITING','REQUESTED']);
/** CheckRun state (status or conclusion) or StatusContext state -> bucket. */
export function bucketOf(state: string): CheckBucket {
  if (state === 'SUCCESS' || state === 'NEUTRAL' || state === 'COMPLETED') return 'ok';
  if (state === 'SKIPPED') return 'skipped';
  if (RUN_PENDING.has(state) || state === 'EXPECTED') return 'pending';
  return 'fail';
}
function check(n: Raw): Check {
  if (n.__typename === 'StatusContext') {
    const bucket = bucketOf(n.state);
    return {name:n.context,source:null,bucket,detail:[n.state,n.description].filter(Boolean).join(' · '),url:n.targetUrl ?? null,startedAt:n.createdAt ?? null,completedAt:null,required:!!n.isRequired};
  }
  const bucket: CheckBucket = n.status !== 'COMPLETED' ? 'pending' : bucketOf(n.conclusion ?? 'COMPLETED');
  return {name:n.name,source:n.checkSuite?.workflowRun?.workflow?.name ?? n.checkSuite?.app?.name ?? null,bucket,detail:(n.conclusion ?? n.status ?? '').toLowerCase(),url:n.detailsUrl ?? null,startedAt:n.startedAt ?? null,completedAt:n.completedAt ?? null,required:!!n.isRequired};
}
/** CI of the PR's head commit. `oid` is the commit the rollup belongs to; callers drop it if it is not the loaded head. */
export async function fetchChecks(ref: PrRef): Promise<Checks> {
  const checks: Check[] = [];
  let after: string | null = null, oid = '', state: string | null = null, total = 0;
  const counts: Record<CheckBucket,number> = {ok:0,fail:0,pending:0,skipped:0};
  for (let page = 0; page < 5; page++) {
    const res: {data: Raw} = await gql<Raw>(`query($owner:String!,$repo:String!,$number:Int!,$after:String) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) { commits(last:1) { nodes { commit { oid statusCheckRollup { state ${CONTEXTS} } } } } } } }`,{...vars(ref),after});
    const commit: Raw | undefined = res.data.repository?.pullRequest?.commits.nodes[0]?.commit;
    if (!commit) break;
    if (page > 0 && commit.oid !== oid) throw new Error('Head moved while loading checks');
    oid = commit.oid;
    const rollup: Raw | null = commit.statusCheckRollup;
    if (!rollup) break;
    state = rollup.state; total = rollup.contexts.totalCount;
    if (page === 0) for (const c of [...(rollup.contexts.checkRunCountsByState ?? []),...(rollup.contexts.statusContextCountsByState ?? [])]) counts[bucketOf(c.state)] += c.count;
    checks.push(...rollup.contexts.nodes.filter((n: Raw) => n.__typename === 'CheckRun' || n.__typename === 'StatusContext').map(check));
    if (!rollup.contexts.pageInfo.hasNextPage) break;
    after = rollup.contexts.pageInfo.endCursor;
  }
  return {oid,state,checks,total,counts};
}

const ISSUE_COMMENT = `id body bodyHTML createdAt author { login avatarUrl } url viewerCanUpdate viewerCanDelete ${REACTIONS}`;
const REVIEW = `id state body bodyHTML submittedAt author { login avatarUrl } url ${REACTIONS}`;
const issueComment = ({reactionGroups, viewerCanReact, ...c}: Raw): IssueComment => ({...c,author:c.author ?? null,...reactable({reactionGroups,viewerCanReact})} as IssueComment);
const review = ({reactionGroups, viewerCanReact, ...r}: Raw): ReviewSummary => ({...r,author:r.author ?? null,...reactable({reactionGroups,viewerCanReact})} as ReviewSummary);
/** Newest first: up to 10 pages each of comments and reviews; `truncated` when older ones exist. */
export async function fetchConversation(ref: PrRef): Promise<Conversation> {
  const q = (comments: boolean, reviews: boolean) => `query($owner:String!,$repo:String!,$number:Int!${comments ? ',$cb:String' : ''}${reviews ? ',$rb:String' : ''}) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) { body bodyHTML createdAt ${REACTIONS} ${comments ? `comments(last:100,before:$cb) { nodes { ${ISSUE_COMMENT} } pageInfo { hasPreviousPage startCursor } }` : ''} ${reviews ? `reviews(last:100,before:$rb,states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]) { nodes { ${REVIEW} } pageInfo { hasPreviousPage startCursor } }` : ''} } } }`;
  const {data} = await gql<Raw>(q(true,true),vars(ref));
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error('Pull request not found');
  let comments: Raw[] = pr.comments.nodes, reviews: Raw[] = pr.reviews.nodes;
  let ci = pr.comments.pageInfo, ri = pr.reviews.pageInfo;
  for (let page = 1; page < 10 && (ci.hasPreviousPage || ri.hasPreviousPage); page++) {
    const {data:next} = await gql<Raw>(q(ci.hasPreviousPage,ri.hasPreviousPage),{...vars(ref),...(ci.hasPreviousPage ? {cb:ci.startCursor} : {}),...(ri.hasPreviousPage ? {rb:ri.startCursor} : {})});
    const p = next.repository.pullRequest;
    if (p.comments) { comments = [...p.comments.nodes,...comments]; ci = p.comments.pageInfo; }
    if (p.reviews) { reviews = [...p.reviews.nodes,...reviews]; ri = p.reviews.pageInfo; }
  }
  return {body:pr.body,bodyHTML:pr.bodyHTML,createdAt:pr.createdAt,...reactable(pr),comments:comments.map(issueComment),reviews:reviews.map(review),truncated:!!(ci.hasPreviousPage || ri.hasPreviousPage)};
}
/** Adds or removes the viewer's reaction; returns the subject's reactions after the change. */
export async function setReaction(subjectId: string, content: ReactionContent, on: boolean): Promise<Reaction[]> {
  const m = on ? 'addReaction' : 'removeReaction';
  const {data} = await gql<Raw>(`mutation($input:${on ? 'AddReactionInput' : 'RemoveReactionInput'}!) { ${m}(input:$input) { subject { ${REACTIONS} } } }`,{input:{subjectId,content}});
  return reactions(data[m].subject.reactionGroups);
}
/** Who reacted, per reaction (up to 20 each), for a tooltip. */
export async function fetchReactors(subjectId: string): Promise<Partial<Record<ReactionContent,{logins:string[];total:number}>>> {
  const who = '... on User { login } ... on Bot { login } ... on Organization { login } ... on Mannequin { login }';
  const {data} = await gql<Raw>(`query($id:ID!) { node(id:$id) { ... on Reactable { reactionGroups { content reactors(first:20) { totalCount nodes { ${who} } } } } } }`,{id:subjectId});
  return Object.fromEntries((data.node?.reactionGroups ?? []).map((g: Raw) => [g.content,{logins:g.reactors.nodes.map((n: Raw) => n.login).filter(Boolean),total:g.reactors.totalCount}]));
}
export async function addIssueComment(subjectId: string, body: string): Promise<IssueComment> {
  const {data} = await gql<Raw>(`mutation($input:AddCommentInput!) { addComment(input:$input) { commentEdge { node { ${ISSUE_COMMENT} } } } }`,{input:{subjectId,body}});
  return issueComment(data.addComment.commentEdge.node);
}
export async function updateIssueComment(id: string, body: string): Promise<IssueComment> {
  const {data} = await gql<Raw>(`mutation($input:UpdateIssueCommentInput!) { updateIssueComment(input:$input) { issueComment { ${ISSUE_COMMENT} } } }`,{input:{id,body}});
  return issueComment(data.updateIssueComment.issueComment);
}
export async function deleteIssueComment(id: string): Promise<void> { await gql('mutation($id:ID!) { deleteIssueComment(input:{id:$id}) { clientMutationId } }',{id}); }

/** Live status of many PRs in one query; a PR that errors (deleted, no access) is left out. */
export async function fetchRecentStatus(refs: PrRef[]): Promise<Map<string,RecentStatus>> {
  const out = new Map<string,RecentStatus>();
  if (!refs.length) return out;
  const variables: Raw = {};
  const fields = refs.map((r,i) => {
    variables[`o${i}`] = r.owner; variables[`r${i}`] = r.repo; variables[`n${i}`] = r.number;
    return `p${i}:repository(owner:$o${i},name:$r${i}) { pullRequest(number:$n${i}) { title state isDraft headRefOid reviewDecision commits(last:1) { nodes { commit { statusCheckRollup { state } } } } } }`;
  }).join(' ');
  const decl = refs.map((_,i) => `$o${i}:String!,$r${i}:String!,$n${i}:Int!`).join(',');
  const {data} = await gql<Raw>(`query(${decl}) { ${fields} }`,variables,{allowPartial:true});
  refs.forEach((r,i) => {
    const pr = data?.[`p${i}`]?.pullRequest;
    if (pr) out.set(`${r.owner}/${r.repo}#${r.number}`,{title:pr.title,state:pr.state,isDraft:pr.isDraft,headOid:pr.headRefOid,reviewDecision:pr.reviewDecision ?? null,ci:pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null});
  });
  return out;
}
