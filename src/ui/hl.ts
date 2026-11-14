import { useEffect, useSyncExternalStore } from 'react';
import type { FileModel } from '../types.ts';
import { languageOf } from '../lib/languages.ts';
import type { RowToks } from '../lib/highlight.ts';

export type { RowToks };
/** A grammar can backtrack badly on odd input; past this the file stays plain and the worker is replaced. */
const DEADLINE_MS = 1500;

/** Highlighting runs in one worker, one file at a time; files on screen jump the queue. Results are cached per model. */
const done = new WeakMap<FileModel, RowToks | null>();
const subs = new WeakMap<FileModel, Set<() => void>>();
let queue: Array<{ model: FileModel; lang: string }> = [];
let busy: FileModel | null = null;
let worker: Worker | null = null;
let jobId = 0;

function finish(model: FileModel, toks: RowToks | null) {
  done.set(model, toks);
  subs.get(model)?.forEach(f => f());
}

function pump() {
  if (busy || !queue.length) return;
  const { model, lang } = queue.shift()!;
  busy = model;
  const id = ++jobId;
  const fail = () => {
    clearTimeout(timer);
    worker?.terminate();
    worker = null;
    finish(model, null);
    busy = null;
    pump();
  };
  const timer = setTimeout(fail, DEADLINE_MS);
  try {
    worker ??= new Worker(new URL('../lib/hl.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = fail;
    worker.onmessage = (e: MessageEvent<{ id: number; tokens: RowToks | null }>) => {
      if (e.data.id !== id) return;
      clearTimeout(timer);
      finish(model, e.data.tokens);
      busy = null;
      pump();
    };
    worker.postMessage({ id, lang, rows: model.rows.map(r => ({ kind: r.kind, text: r.text })) });
  } catch {
    clearTimeout(timer);
    finish(model, null);
    busy = null;
  }
}

export function requestHighlight(model: FileModel, path: string, urgent: boolean) {
  if (done.has(model) || busy === model || typeof Worker === 'undefined') return;
  const i = queue.findIndex(q => q.model === model);
  if (i >= 0) {
    if (urgent && i > 0) queue.unshift(...queue.splice(i, 1));
    return;
  }
  const lang = languageOf(path);
  if (!lang) {
    done.set(model, null);
    return;
  }
  if (urgent) queue.unshift({ model, lang });
  else queue.push({ model, lang });
  pump();
}

function cancel(model: FileModel) {
  queue = queue.filter(q => q.model !== model);
}

/** Row tokens for `model`, or undefined until ready / when off. */
export function useHighlight(model: FileModel, path: string, enabled: boolean): RowToks | undefined {
  useEffect(() => {
    if (!enabled) return;
    requestHighlight(model, path, false);
    return () => cancel(model);
  }, [model, path, enabled]);
  const toks = useSyncExternalStore(
    cb => {
      let set = subs.get(model);
      if (!set) subs.set(model, (set = new Set()));
      set.add(cb);
      return () => set.delete(cb);
    },
    () => done.get(model),
  );
  return enabled ? toks ?? undefined : undefined;
}
