export interface FuzzyHit {
  path: string;
  score: number;
  /** Indices into path of the matched chars, ascending. */
  hits: number[];
}

function fold(value: string): string {
  const lower = value.toLowerCase();
  return lower.length === value.length ? lower : value.split('').map(char => char.toLowerCase()[0]).join('');
}

function alignment(path: string, lower: string, query: string, rows: [Float64Array, Float64Array], hits?: number[]): number {
  const n = path.length;
  const base = path.lastIndexOf('/') + 1;
  let start = base;
  if (!lower.startsWith(query, base)) {
    for (const char of query) {
      start = lower.indexOf(char, start);
      if (start === -1) break;
      start++;
    }
    start = start === -1 ? 0 : base;
  }
  const parents = hits ? new Int32Array(n * query.length) : undefined;
  let previous = rows[0], current = rows[1];
  let score = -Infinity, end = -1;
  for (let i = 0; i < query.length; i++) {
    let best = -Infinity, bestIndex = -1;
    let prev = i ? lower.indexOf(query[i - 1], start + i - 1) : -1;
    for (let pos = lower.indexOf(query[i], start + i); pos !== -1; pos = lower.indexOf(query[i], pos + 1)) {
      let value = 0, parent = -1;
      if (i) {
        while (prev !== -1 && prev < pos) {
          if (previous[prev] > best) { best = previous[prev]; bestIndex = prev; }
          prev = lower.indexOf(query[i - 1], prev + 1);
        }
        value = best; parent = bestIndex;
        if (pos >= i && lower[pos - 1] === query[i - 1] && previous[pos - 1] + 24 >= value) {
          value = previous[pos - 1] + 24; parent = pos - 1;
        }
      }
      const before = path.charCodeAt(pos - 1), char = path.charCodeAt(pos);
      const boundary = pos === 0 || before === 47 || before === 95 || before === 45 || before === 46 || before === 32
        || (before >= 97 && before <= 122 && char >= 65 && char <= 90);
      value += (pos >= base ? 40 : 0) + (boundary ? 12 : 0);
      if (i === 0 && pos === base && lower.startsWith(query, base)) value += 8;
      current[pos] = value;
      if (parents) parents[i * n + pos] = parent;
      if (i === query.length - 1 && value > score) { score = value; end = pos; }
    }
    const swap = previous; previous = current; current = swap;
  }
  if (hits && parents) {
    for (let i = query.length - 1; i >= 0; i--) {
      hits[i] = end;
      end = parents[i * n + end];
    }
  }
  return score - n * 0.01;
}

function compare(a: FuzzyHit, b: FuzzyHit): number {
  return b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Best matches first. Empty or blank queries return no matches. */
export function fuzzyFind(paths: readonly string[], query: string, limit: number): FuzzyHit[] {
  query = fold(query.replace(/\s/g, ''));
  limit = Math.min(paths.length, Math.floor(limit));
  if (!query || !(limit > 0)) return [];
  const top: FuzzyHit[] = [];
  let rows: [Float64Array, Float64Array] = [new Float64Array(128), new Float64Array(128)];
  for (const path of paths) {
    const lower = fold(path);
    let pos = 0, i = 0;
    for (; i < query.length; i++) {
      pos = lower.indexOf(query[i], pos);
      if (pos === -1) break;
      pos++;
    }
    if (i !== query.length) continue;
    if (path.length > rows[0].length) rows = [new Float64Array(path.length), new Float64Array(path.length)];
    const candidate: FuzzyHit = {path, score:alignment(path, lower, query, rows), hits:[]};
    if (top.length === limit && compare(candidate, top[top.length - 1]) >= 0) continue;
    let lo = 0, hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(candidate, top[mid]) < 0) hi = mid;
      else lo = mid + 1;
    }
    top.splice(lo, 0, candidate);
    if (top.length > limit) top.pop();
  }
  for (const hit of top) alignment(hit.path, fold(hit.path), query, rows, hit.hits);
  return top;
}
