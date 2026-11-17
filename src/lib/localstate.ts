import type { LocalComment, LocalThread, NewThread, PrFile, ReviewDoc, ReviewRef, Thread, User, ViewedState } from '../types';
import { ApiError, local } from './api';
import { refKey } from './refs';

type Op = {apply: (doc: ReviewDoc) => void; resolve: () => void; reject: (error: Error) => void};
type Waiter = {resolve: () => void; reject: (error: Error) => void};
const clone = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
const statePath = (key: string) => `state?key=${encodeURIComponent(key)}`;

export class LocalReview {
  readonly key: string;
  private acknowledged: ReviewDoc;
  private pending: Op[] = [];
  private flight: Op[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private writing = false;
  private recovering: Error | null = null;
  private waiters: Waiter[] = [];
  private listeners = new Set<(doc: ReviewDoc, reason: string) => void>();

  private constructor(doc: ReviewDoc) { this.key = doc.key; this.acknowledged = clone(doc); }

  static async open(ref: ReviewRef, title: string): Promise<LocalReview> {
    const key = refKey(ref);
    try { return new LocalReview(await local<ReviewDoc>(statePath(key))); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      return new LocalReview({key,ref,title,version:0,updatedAt:now(),viewed:{},threads:[]});
    }
  }

  doc(): ReviewDoc {
    const doc = clone(this.acknowledged);
    for (const op of [...this.flight, ...this.pending]) op.apply(doc);
    return doc;
  }

  onReplace(fn: (doc: ReviewDoc, reason: string) => void): () => void {
    this.listeners.add(fn); return () => { this.listeners.delete(fn); };
  }

  private enqueue<T>(apply: (doc: ReviewDoc) => T): Promise<T> {
    if (this.recovering) return Promise.reject(this.recovering);
    const timestamp = now();
    const update = (doc: ReviewDoc) => { const result = apply(doc); doc.updatedAt = timestamp; return result; };
    let result: T;
    try { result = clone(update(this.doc())); } catch (error) { return Promise.reject(error); }
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.push({apply:update,resolve:() => resolve(clone(result)),reject});
    });
    this.schedule(); return promise;
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.write(); }, 300);
  }

  private async write(): Promise<void> {
    if (this.writing || this.recovering || !this.pending.length) return;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    this.writing = true;
    this.flight = this.pending.splice(0);
    const sent = this.doc();
    try {
      const {version} = await local<{version: number}>(statePath(this.key), {method:'PUT',body:{doc:sent,baseVersion:this.acknowledged.version}});
      this.acknowledged = {...sent,version};
      const completed = this.flight; this.flight = [];
      for (const op of completed) op.resolve();
    } catch (error) {
      const reason = error instanceof ApiError && error.status === 409 ? 'Changed elsewhere; reloaded' : `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      const failure = new Error(reason); this.recovering = failure;
      if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
      const dropped = [...this.flight, ...this.pending]; this.flight = []; this.pending = [];
      for (const op of dropped) op.reject(failure);
      try { this.acknowledged = await local<ReviewDoc>(statePath(this.key)); }
      catch (reloadError) {
        if (reloadError instanceof ApiError && reloadError.status === 404) {
          this.acknowledged = {...this.acknowledged,version:0,viewed:{},threads:[]};
        }
      }
      for (const listener of this.listeners) listener(this.doc(), reason);
      for (const waiter of this.waiters.splice(0)) waiter.reject(failure);
      this.recovering = null;
    } finally {
      this.writing = false;
      if (this.pending.length) {
        if (this.waiters.length) void this.write();
        else this.schedule();
      } else for (const waiter of this.waiters.splice(0)) waiter.resolve();
    }
  }

  addThread(t: NewThread): Promise<LocalThread> {
    const thread: LocalThread = {id:crypto.randomUUID(),path:t.path,subjectType:t.subjectType,
      side:t.side ?? 'RIGHT',line:t.subjectType === 'FILE' ? null : t.line ?? null,
      startSide:t.subjectType === 'FILE' ? null : t.startSide ?? null,startLine:t.subjectType === 'FILE' ? null : t.startLine ?? null,
      quote:t.subjectType === 'FILE' ? [] : clone(t.quote ?? []),outdated:false,resolved:false,
      comments:[{id:crypto.randomUUID(),body:t.body,createdAt:now()}]};
    return this.enqueue(doc => { doc.threads.push(clone(thread)); return thread; });
  }

  reply(threadId: string, body: string): Promise<LocalComment> {
    const comment: LocalComment = {id:crypto.randomUUID(),body,createdAt:now()};
    return this.enqueue(doc => { findThread(doc, threadId).comments.push(clone(comment)); return comment; });
  }

  edit(commentId: string, body: string): Promise<LocalComment> {
    const updatedAt = now();
    return this.enqueue(doc => { const comment = findComment(doc, commentId); comment.body = body; comment.updatedAt = updatedAt; return comment; });
  }

  remove(commentId: string): Promise<void> {
    return this.enqueue(doc => {
      findComment(doc, commentId);
      for (const thread of doc.threads) thread.comments = thread.comments.filter(c => c.id !== commentId);
      doc.threads = doc.threads.filter(t => t.comments.length);
    });
  }

  resolve(threadId: string, resolved: boolean): Promise<void> {
    return this.enqueue(doc => { findThread(doc, threadId).resolved = resolved; });
  }

  setViewed(items: Array<{path: string; fingerprint: string | null}>): Promise<void> {
    const intents = clone(items);
    return this.enqueue(doc => {
      for (const item of intents) {
        if (item.fingerprint === null) delete doc.viewed[item.path];
        else doc.viewed = {...doc.viewed, [item.path]:item.fingerprint};
      }
    });
  }

  setOutdated(flags: Record<string, boolean>): void {
    const doc = this.doc();
    const changed = doc.threads.filter(t => Object.hasOwn(flags, t.id) && flags[t.id] !== t.outdated).map(t => ({id:t.id,value:flags[t.id]}));
    if (!changed.length) return;
    void this.enqueue(doc => { for (const flag of changed) findThread(doc, flag.id).outdated = flag.value; }).catch(() => {});
  }

  setTitle(title: string): void {
    if (this.doc().title === title) return;
    // a review nobody wrote to yet stays unsaved; the title goes out with its first write
    if (this.acknowledged.version === 0 && !this.pending.length && !this.flight.length) { this.acknowledged.title = title; return; }
    void this.enqueue(doc => { doc.title = title; }).catch(() => {});
  }

  flush(): Promise<void> {
    if (!this.writing && !this.pending.length && !this.recovering) return Promise.resolve();
    const promise = new Promise<void>((resolve, reject) => { this.waiters.push({resolve,reject}); });
    void this.write(); return promise;
  }
}

function findThread(doc: ReviewDoc, id: string): LocalThread {
  const thread = doc.threads.find(t => t.id === id);
  if (!thread) throw new Error(`Unknown thread: ${id}`);
  return thread;
}

function findComment(doc: ReviewDoc, id: string): LocalComment {
  const comment = doc.threads.flatMap(t => t.comments).find(c => c.id === id);
  if (!comment) throw new Error(`Unknown comment: ${id}`);
  return comment;
}

export function toThreads(doc: ReviewDoc, viewer: User): Thread[] {
  return doc.threads.map(t => ({id:t.id,path:t.path,line:t.line,startLine:t.startLine,originalLine:null,side:t.side,startSide:t.startSide,
    isResolved:t.resolved,isOutdated:t.outdated,subjectType:t.subjectType,quote:clone(t.quote),
    viewerCanResolve:!t.resolved,viewerCanUnresolve:t.resolved,viewerCanReply:true,
    comments:t.comments.map(c => ({...c,bodyHTML:'',author:viewer,state:'LOCAL',url:'',viewerCanUpdate:true,viewerCanDelete:true}))}));
}

export function viewedStates(doc: ReviewDoc, files: PrFile[]): Record<string, ViewedState> {
  return Object.fromEntries(files.map(f => [f.path,!Object.hasOwn(doc.viewed, f.path) ? 'UNVIEWED' : doc.viewed[f.path] === f.fingerprint ? 'VIEWED' : 'DISMISSED']));
}
