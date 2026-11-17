import type { PrRef, ReviewRef } from '../types.ts';

const NAME = '[A-Za-z0-9_.-]+';
/** A git ref or sha as GitHub accepts it in a compare URL (no `..` segments, no leading `-`). */
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9_./-]{1,250}$/;
const SHA = /^[0-9a-f]{7,40}$/i;

/** Stable identity of a review; PR keys equal the pre-v3 ones so existing localStorage keys stay valid. */
export function refKey(r: ReviewRef): string {
  switch (r.kind) {
    case 'pr': return `${r.owner}/${r.repo}#${r.number}`;
    case 'commit': return `${r.owner}/${r.repo}@${r.sha}`;
    case 'compare': return `${r.owner}/${r.repo}@${r.base}...${r.head}`;
    case 'local': return `local:${r.repo}:${r.range}`;
    case 'paste': return `paste:${r.id}`;
  }
}

export const isPr = (r: ReviewRef | null | undefined): r is { kind: 'pr' } & PrRef => r?.kind === 'pr';
export const prRef = (r: { kind: 'pr' } & PrRef): PrRef => ({ owner: r.owner, repo: r.repo, number: r.number });
/** owner/repo of sources that live on GitHub */
export const ghRepo = (r: ReviewRef): { owner: string; repo: string } | null =>
  r.kind === 'pr' || r.kind === 'commit' || r.kind === 'compare' ? { owner: r.owner, repo: r.repo } : null;

export function sameReview(a: ReviewRef | null, b: ReviewRef | null): boolean {
  return a === b || (!!a && !!b && refKey(a) === refKey(b));
}

export type RefTab = 'diff' | 'overview' | 'conversation';

/**
 * Parses an app path (`/o/r/pull/1/overview`, `/o/r/commit/<sha>`, `/o/r/compare/a...b`, `/local`, `/paste/<id>`)
 * plus its query. Non-PR kinds carry the tab in `?tab=` (a path suffix would be ambiguous after a compare ref).
 */
export function parseAppPath(pathname: string, search: string): { ref: ReviewRef; tab: RefTab | null } | null {
  const q = new URLSearchParams(search);
  const qtab = (['overview', 'conversation'] as const).find(t => t === q.get('tab')) ?? null;
  let m = new RegExp(`^/(${NAME})/(${NAME})/pull/([1-9]\\d*)(?:/(overview|conversation|files|commits|checks))?/?$`).exec(pathname);
  if (m) {
    const number = Number(m[3]);
    if (!Number.isSafeInteger(number)) return null;
    const tab = m[4] === 'overview' || m[4] === 'conversation' ? m[4] : null;
    return { ref: { kind: 'pr', owner: m[1], repo: m[2], number }, tab };
  }
  m = new RegExp(`^/(${NAME})/(${NAME})/commit/([0-9a-fA-F]{7,40})/?$`).exec(pathname);
  if (m) return { ref: { kind: 'commit', owner: m[1], repo: m[2], sha: m[3].toLowerCase() }, tab: qtab };
  m = new RegExp(`^/(${NAME})/(${NAME})/compare/(.+)$`).exec(pathname);
  if (m) {
    const spec = safeDecode(m[3]);
    const parts = spec?.split('...');
    if (!parts || parts.length !== 2 || !REF.test(parts[0]) || !REF.test(parts[1])) return null;
    return { ref: { kind: 'compare', owner: m[1], repo: m[2], base: parts[0], head: parts[1] }, tab: qtab };
  }
  if (/^\/local\/?$/.test(pathname)) {
    const repo = q.get('repo');
    if (!repo || !repo.startsWith('/')) return null;
    return { ref: { kind: 'local', repo, range: q.get('range') ?? '' }, tab: qtab };
  }
  m = /^\/paste\/([0-9a-f]{64})\/?$/.exec(pathname);
  if (m) return { ref: { kind: 'paste', id: m[1] }, tab: qtab };
  return null;
}

function safeDecode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

/** App path + query for a review; `extra` query params come after the identifying ones. */
export function appPath(r: ReviewRef, tab: RefTab, extra?: URLSearchParams): string {
  const p = new URLSearchParams();
  let path: string;
  switch (r.kind) {
    case 'pr': path = `/${r.owner}/${r.repo}/pull/${r.number}${tab === 'diff' ? '' : `/${tab}`}`; break;
    case 'commit': path = `/${r.owner}/${r.repo}/commit/${r.sha}`; break;
    case 'compare': path = `/${r.owner}/${r.repo}/compare/${r.base}...${r.head}`; break;
    case 'local': path = '/local'; p.set('repo', r.repo); p.set('range', r.range); break;
    case 'paste': path = `/paste/${r.id}`; break;
  }
  if (r.kind !== 'pr' && tab !== 'diff') p.set('tab', tab);
  for (const [k, v] of extra ?? []) p.set(k, v);
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * A pasted/typed reference: a GitHub or app URL (PR, commit, compare), `o/r#N`, or `o/r/pull/N`. Local and paste
 * refs only come from app URLs.
 */
export function parseReviewInput(s: string): ReviewRef | null {
  s = s.trim();
  const short = new RegExp(`^(${NAME})/(${NAME})#([1-9]\\d*)$`).exec(s);
  if (short) return { kind: 'pr', owner: short[1], repo: short[2], number: Number(short[3]) };
  let path = s, search = '';
  if (/^https?:\/\//.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    const app = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u.origin);
    if (u.origin !== 'https://github.com' && !app) return null;
    path = u.pathname; search = app ? u.search : '';
  } else if (!path.startsWith('/')) path = `/${path}`;
  // PR sub-pages (`/pull/1/files`) are accepted by parseAppPath; a compare ref may itself end in `/files`
  return parseAppPath(path, search)?.ref ?? null;
}

/** Where a review lives on GitHub, if anywhere. */
export function githubUrl(r: ReviewRef): string | null {
  switch (r.kind) {
    case 'pr': return `https://github.com/${r.owner}/${r.repo}/pull/${r.number}`;
    case 'commit': return `https://github.com/${r.owner}/${r.repo}/commit/${r.sha}`;
    case 'compare': return `https://github.com/${r.owner}/${r.repo}/compare/${r.base}...${r.head}`;
    default: return null;
  }
}

export { SHA as SHA_RE };
