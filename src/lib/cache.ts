import type { BlobResult, PrData } from '../types';

let dbP: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  dbP ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('diff-review', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'key' }).createIndex('timestamp', 'timestamp');
      if (!db.objectStoreNames.contains('prs')) db.createObjectStore('prs', { keyPath: 'key' }).createIndex('timestamp', 'timestamp');
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbP = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('blocked'));
  }).catch(e => { dbP = null; throw e; });
  return dbP;
}

function tx(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, mode);
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
    fn(t.objectStore(store));
  });
}

function trim(s: IDBObjectStore, max: number, drop: number) {
  const count = s.count();
  count.onsuccess = () => {
    if (count.result <= max) return;
    let removed = 0;
    const cursor = s.index('timestamp').openCursor();
    cursor.onsuccess = () => {
      if (cursor.result && removed++ < drop) { cursor.result.delete(); cursor.result.continue(); }
    };
  };
}

export async function getMany(keys: string[]): Promise<Map<string, BlobResult>> {
  const result = new Map<string, BlobResult>();
  try {
    const db = await open();
    await tx(db, 'blobs', 'readonly', s => {
      for (const key of keys) {
        const r = s.get(key);
        r.onsuccess = () => { if (r.result) result.set(key, r.result.value); };
      }
    });
    return result;
  } catch {
    return new Map();
  }
}

export async function putMany(entries: Iterable<readonly [string, BlobResult]>): Promise<void> {
  try {
    const db = await open();
    await tx(db, 'blobs', 'readwrite', s => {
      for (const [key, value] of entries) s.put({ key, value, timestamp: Date.now() });
      trim(s, 5000, 1000);
    });
  } catch { /* cache is best-effort */ }
}

/** Last loaded snapshot of a PR, for instant first paint on revisits. */
export async function getPr(key: string): Promise<PrData | null> {
  try {
    const db = await open();
    let v: PrData | null = null;
    await tx(db, 'prs', 'readonly', s => {
      const r = s.get(key);
      r.onsuccess = () => { v = r.result?.value ?? null; };
    });
    return v;
  } catch {
    return null;
  }
}

export async function putPr(key: string, value: PrData): Promise<void> {
  try {
    const db = await open();
    await tx(db, 'prs', 'readwrite', s => {
      s.put({ key, value, timestamp: Date.now() });
      trim(s, 100, 20);
    });
  } catch { /* best-effort */ }
}
