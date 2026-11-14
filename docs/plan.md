# gh-review — plan

A fast, local-only GitHub pull-request review UI for one user on one laptop.

## Goals

- Open any PR by swapping the host: `https://github.com/o/r/pull/N[/files]` → `http://127.0.0.1:7777/o/r/pull/N`
  (a bookmarklet does it). A home page also has a paste-URL box.
- **Snappy above all.** One upfront load. Everything after that is local: switching unified/split, changing
  context, filtering and grouping. Writes are optimistic.
- Draft (pending) review: inline line and range comments, file-level comments, replies, edit and delete own
  drafts, then submit as Comment / Approve / Request changes with a body. Discard the draft.
- Mark files viewed/unviewed (GitHub-synced, bulk). **Hide** files locally (ignore rules such as tests or
  generated files).
- Overview screen: changed files grouped by **category** and by **folder**, with file counts, +/- per group,
  viewed progress, and bulk actions (mark viewed, hide, show only).
- Smaller font (adjustable). Default diff context is 10 lines, adjustable to 3/5/10/15/25/all, with per-hunk
  expand.

## Non-goals (v1)

Multi-user hosting, OAuth, syntax highlighting (add later), editing PR metadata, merge buttons, CI status,
suggestions UI, reactions.

## Verified facts (2026-11-14, via `gh` OAuth token, user `mitio`)

- GraphQL has `markFileAsViewed`/`unmarkFileAsViewed(pullRequestId, path)`. `PullRequestChangedFile` has
  `path, additions, deletions, changeType, viewerViewedState` (`VIEWED|UNVIEWED|DISMISSED`). It does not have
  the previous filename, so we also need REST.
- Pending review: `addPullRequestReview(pullRequestId, commitOID)` with no `event` creates a PENDING review.
  `addPullRequestReviewThread(pullRequestReviewId, path, body, line, side, startLine, startSide, subjectType)`,
  `addPullRequestReviewThreadReply(pullRequestReviewThreadId, pullRequestReviewId, body)`,
  `updatePullRequestReviewComment`, `deletePullRequestReviewComment`,
  `submitPullRequestReview(pullRequestReviewId, event, body)`, `deletePullRequestReview`,
  `resolveReviewThread`/`unresolveReviewThread`.
- **A line comment outside GitHub's own diff hunks (3-line context) is silently dropped:**
  `addPullRequestReviewThread` returns `thread: null` with no error. Tested on a small private PR (README.md line 10
  RIGHT returned null; line 85, inside a hunk, worked). A `subjectType: FILE` thread works. So:
  commentable lines = the lines inside the hunks of the REST `patch` field. Clicking any other line opens a
  file-level comment prefilled with `` `L10` `` plus a quote of the line. A `thread: null` response is
  treated as an error.
- `Blob { text isBinary isTruncated byteSize oid }` can be fetched via
  `repository { object(expression: "<sha>:<path>") }`, so many blobs can be batched in one aliased query.

## Architecture

```
browser (React 19 + Vite SPA)  ──/api/*──▶  server/server.ts (Node 24, no deps, type-stripping)
  ├─ IndexedDB blob cache                      ├─ token = `gh auth token` (cached; re-read once on 401)
  └─ all diffing / grouping local              ├─ POST /api/graphql   → api.github.com/graphql
                                               ├─ GET  /api/rest/<p>  → api.github.com/<p>
                                               └─ static dist/ + SPA fallback
```

- `npm start` runs `vite build` and then `node server/server.ts`, which serves on `127.0.0.1:7777` (`PORT` env).
  `npm run dev` runs the server plus Vite dev (5173, proxying `/api`).
- **The token never reaches the browser.** The server guards against other websites using the proxy
  (CSRF / DNS rebinding):
  binds 127.0.0.1 only; rejects requests whose `Host` is not `127.0.0.1:<port>`/`localhost:<port>`; `/api/*`
  requires header `x-ghr: 1` (forces a CORS preflight, which we never approve) and, if present, an `Origin`
  equal to our own. REST proxy is GET-only; the path must match `^repos/[^/]+/[^/]+/(pulls|compare)/`.
- All GitHub logic lives in the client (`src/lib`), so the server stays a dumb proxy.

## Data loading (one PR)

In parallel at start:
1. GraphQL `PR_QUERY`: id, number, title, url, state, isDraft, author{login avatarUrl}, viewer{login},
   baseRefName, headRefName, baseRefOid, headRefOid, changedFiles, additions, deletions,
   `files(first:100)` {path viewerViewedState} (paginate),
   `reviewThreads(first:100)` {id path line startLine originalLine diffSide startDiffSide isResolved
   isOutdated subjectType viewerCanResolve viewerCanUnresolve viewerCanReply
   comments(first:100){id databaseId body bodyHTML createdAt author{login avatarUrl} state url viewerCanUpdate
   viewerCanDelete pullRequestReview{id}}} (paginate threads),
   `reviews(states:PENDING, first:20)` {id author{login}} → the viewer's pending review id.
2. REST `GET repos/o/r/pulls/N/files?per_page=100&page=k`. Fetch page 1 first, then pages
   2..ceil(changedFiles/100) in parallel (cap 30 pages). Gives filename, previous_filename, status,
   additions, deletions, patch (may be absent), sha.
3. REST `GET repos/o/r/compare/<baseRefOid>...<headRefOid>?per_page=1` gives `merge_base_commit.sha`. This
   needs `baseRefOid`, so it is chained after step 1.

First paint uses the overview and file list as soon as 2 is done, and file diffs from the parsed `patch`
(3-line context). Then blobs: only the head blob `headRefOid:filename` for modified/renamed/copied/changed files
that have a patch. Patch-less files need both sides (base = `mergeBase:previous_filename||filename`), and those
are fetched on demand when the file scrolls into view. Blobs are fetched in aliased GraphQL batches of 40 objects,
4 batches concurrent, in display order (prioritising the file in view). Results are cached in IndexedDB under
`o/r/<commitSha>:<path>` (immutable). When both sides of a file are present, its diff switches to the full
model (any context, expandable). Binary, truncated or missing → stay on the patch view (or "binary file").

Refresh: `r` key and window focus (throttled to 30s) refetch query 1 only (threads, viewed state, head).
If `headRefOid` changed → banner "New commits — reload".

## Diff model (`src/lib/diff.ts`)

**GitHub's patch is the alignment source of truth. We do not re-diff when a patch exists.** This came out of
the plan review: an independent re-diff can align repeated text differently, which hides thread anchors and
breaks the commentable-line parity.

- `parsePatch(patch): ParsedPatch` gives `{ hunks: {oldStart, oldLines, newStart, newLines, header, rows: Row[]}[] }`.
  Row = `{kind, oldNo?, newNo?, text, hunk?: number /* GitHub hunk index */, noEol?: true, cr?: true}`.
  `\ No newline at end of file` sets `noEol` on the preceding row (so each side is handled on its own).
  A trailing `\r` is stripped from `text` and recorded as `cr` (rendered as a visible `␍` marker, so a
  CRLF→LF change is visible).
- `buildFull(parsed, headText | null, baseText | null): Row[]`: the full-file row list. Unchanged gaps
  between, before and after the hunks are filled with `ctx` rows taken from the head blob (new line numbers;
  old number = new − offset, where offset = `newStart − oldStart` of the adjacent hunk, constant inside a gap).
  This needs only the **head** blob for modified/renamed files. Added and removed files need no blob, since
  the patch has every line. Gap rows have no `hunk`. Without the blob, the result is just the hunks with
  unknown gaps (first paint).
- `view(rows, context, expansions): Item[]`: the rows to show for a given context (gap rows within
  `context` of a change are shown; `context` can be `Infinity`), plus `{kind:'gap', from, to, count}`
  placeholders. `expansions` is a per-file map gapKey→{up, down} (+20 per click, or all). The function is
  pure and memoised per (file, context, expansions).
- `splitPairs(items)`: for split view, pairs consecutive del/add runs side by side.
- `wordDiff(a, b)`: intraline highlight for paired del/add lines (jsdiff `diffWordsWithSpace`), only when
  both lines are under 500 chars. Lazy and memoised.
- Commentable: a line is commentable iff it has a `hunk` index (i.e. it is in GitHub's patch). A range is valid
  iff both ends are on the same side and in the same `hunk`, otherwise the composer explains why and offers a
  single-line or file comment instead.
- **Patch-less files** (GitHub omits `patch` for very large diffs): fetch both blobs (base at
  `mergeBase:previousPath||path`) and diff in a **Web Worker** (jsdiff `diffArrays` on lines with
  `timeout: 3000`). A timeout or binary file gives "Diff too large — open on GitHub". No lines in these files
  are commentable (GitHub has no hunks for them), so they only allow file comments.

## Categories, folders, ignore (`src/lib/categorize.ts`)

- Category (first match wins): `generated` (lockfiles: `*.lock, package-lock.json, pnpm-lock.yaml,
  yarn.lock, Gemfile.lock, go.sum, poetry.lock, Cargo.lock`; `*.min.*`, `*.snap`, `*.pb.go`, `*_pb2.py`,
  `**/generated/**`, `**/__generated__/**`, `db/schema.rb`, `db/structure.sql`, `*.svg`), `tests`
  (`spec/`, `test/`, `tests/`, `__tests__/`, `*_spec.*`, `*_test.*`, `*.test.*`, `*.spec.*`,
  `test_*.py`, `**/fixtures/**`, `**/cassettes/**`), `migrations` (`db/migrate/**`, `**/migrations/**`),
  `docs` (`*.md`, `*.mdx`, `*.rst`, `*.txt`, `docs/**`), `config` (`*.yml`, `*.yaml`, `*.json`, `*.toml`,
  `*.ini`, `Dockerfile*`, `.github/**`, `*.tf`, `*.hcl`, `.*rc`, `Makefile`), `styles` (`*.css`, `*.scss`),
  else `source`.
- Folder grouping: by the first N path segments (N = 1..4, selectable, default 2). Files at a shallower depth
  group under their own directory. Root files go under `/`.
- Ignore rules: per-repo list of globs (`*`, `**`, `?`, `{a,b}`; matched against the full path) in
  localStorage key `ghr:ignore:o/r`, plus per-PR explicit hidden paths `ghr:hidden:o/r#N`. Quick actions
  from the overview: hide a category (adds the category's globs as a rule), hide a folder (`dir/**`), hide a
  file. Hidden files are removed from the diff stream and dimmed in the sidebar; there is a "show hidden"
  toggle. Hidden is local only, while viewed is GitHub-synced.
- Group stats: `{files, additions, deletions, viewed, hidden}`.

## UI (Claude builds)

Layout: top bar, left sidebar (resizable, ~300px), main pane. Compact: base font 12px for diffs
(`--diff-font` 10–16px, `-`/`=` keys), 13px for the UI.

- **Top bar** (one row): PR title (links to GitHub) · #N · author avatar+login · `base ← head` · state chip ·
  stat chips (files, +adds, −dels, viewed x/y) · `Overview | Diff` tabs · `Unified|Split` segmented
  control · context select · font −/+ · draft chip ("Draft · 3") · **Review** button (opens the submit
  panel).
- **Sidebar**: filter input (`/`), grouping select (Tree / Category / Flat), "show hidden" toggle. Each file row
  has a viewed checkbox, status letter (A/M/D/R, coloured), name, and a +/- mini bar. Groups are collapsible and
  have their own checkbox (marks the whole group viewed), counts and a "hide" action. Clicking a file scrolls
  the main pane to it. The current file (scroll-spy) is highlighted.
- **Overview tab**: two side-by-side panels, "By category" and "By folder" (depth selector). Each is a
  compact table with group name, files, +/−, a churn bar, a viewed progress bar, and actions [✓ viewed] [hide]
  [only]. Clicking a group expands its file list inline. A "Hidden rules" panel lists active globs (removable)
  and has an input to add one.
- **Diff tab**: stacked file blocks for visible (non-hidden, filtered) files. Each has a sticky header with
  collapse caret, path (renames as `old → new`), +/- chip, "changed since viewed" chip if DISMISSED,
  [comment on file] button, "Viewed" checkbox (checking collapses the block), and a link to GitHub. Viewed
  files start collapsed. Body: hunks with gap rows ("↕ 37 hidden lines" click expands +20 / all). Unified =
  4-col grid (oldNo, newNo, sign, text). Split = (oldNo, old, newNo, new). Hovering a commentable line shows
  a `+` button. Click opens the composer below the line. Shift-click extends to a range on the same side.
  Clicking a non-commentable line opens a file-level composer with an `L<n>` quote.
- **Threads** render inline under their line (`diffSide`+`line` → row with that old/new number), with
  resolved threads collapsed. Outdated threads and file-level threads are listed under the file header.
  Each comment shows avatar, login, a relative time and the body (`bodyHTML` sanitised by DOMPurify). Pending
  comments get a "Pending" chip. Own pending comments have edit/delete. Each thread has reply and
  resolve/unresolve.
- **Composer**: textarea with ⌘↵ = "Add to review" (creates the pending review lazily), Esc cancels, and the
  draft text is kept in localStorage while open.
- **Submit panel**: body textarea, radio Comment/Approve/Request changes, Submit, and Discard draft (confirm).
- Keys: `j/k` next/prev file, `v` toggle viewed on current file then jump to next unviewed, `s` toggle
  split/unified, `[`/`]` context down/up, `o` overview, `d` diff, `/` filter, `-`/`=` font, `r` refresh,
  `?` help.
- Perf: each file block is a memoised component. Its rows mount only once it has come within 2000px of the
  viewport (IntersectionObserver), otherwise it is a placeholder sized by an estimate; it stays mounted after
  that. `content-visibility:auto` is on blocks. Files with more than 3000 changed rows start collapsed with "Load
  diff". Store updates are keyed per file so toggling viewed re-renders one block.
- Settings in localStorage `ghr:settings` (viewMode, context, fontSize, sidebar grouping, folderDepth,
  showHidden, sidebarWidth).

## Writes (optimistic)

- Viewed: set local state at once, send aliased mutations batched (≤50 per request, debounced 150ms),
  revert and toast on error.
- Comments: show the pending comment immediately with a temp id, replace it with the server result, and
  remove it plus toast on error (the composer text is restored).
- Error toasts are stacked bottom-right. GraphQL `errors` arrays count as errors even with HTTP 200.

## Contracts (`src/types.ts`)

```ts
export type ViewedState = 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
export type Side = 'LEFT' | 'RIGHT';
export interface PrRef { owner: string; repo: string; number: number }
export interface User { login: string; avatarUrl: string }
export interface PrFile {
  path: string; previousPath?: string;
  status: 'added'|'removed'|'modified'|'renamed'|'copied'|'changed'|'unchanged';
  additions: number; deletions: number; patch?: string; viewed: ViewedState;
}
export interface Comment {
  id: string; databaseId?: number; body: string; bodyHTML: string; createdAt: string; author: User | null;
  state: 'PENDING'|'SUBMITTED'|string; url: string; viewerCanUpdate: boolean; viewerCanDelete: boolean;
  reviewId?: string;
}
export interface Thread {
  id: string; path: string; line: number | null; startLine: number | null; originalLine: number | null;
  side: Side; startSide: Side | null; isResolved: boolean; isOutdated: boolean; subjectType: 'LINE'|'FILE';
  viewerCanResolve: boolean; viewerCanUnresolve: boolean; viewerCanReply: boolean; comments: Comment[];
}
export interface PrData {
  ref: PrRef; id: string; title: string; url: string; state: string; isDraft: boolean; author: User | null;
  viewer: User; baseRefName: string; headRefName: string; baseOid: string; headOid: string; mergeBaseOid: string;
  additions: number; deletions: number; changedFiles: number;
  files: PrFile[]; threads: Thread[]; pendingReviewId: string | null;
}
export type Row = {
  kind: 'ctx'|'del'|'add'; oldNo?: number; newNo?: number; text: string;
  hunk?: number; noEol?: true; cr?: true;
};
export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; header: string; rows: Row[] }
export interface ParsedPatch { hunks: Hunk[] }
export type Item =
  | { kind: 'row'; row: Row; idx: number }
  | { kind: 'gap'; key: string; count: number; canUp: boolean; canDown: boolean };
export type Expansions = Record<string, { up: number; down: number } | 'all'>;
export type Category = 'generated'|'tests'|'migrations'|'docs'|'config'|'styles'|'source';
export type HideRule =
  | { kind: 'category'; category: Category }
  | { kind: 'glob'; pattern: string }
  | { kind: 'path'; path: string };
export interface BlobResult { text: string | null; binary: boolean; truncated: boolean; missing: boolean }
```

`src/lib/github.ts` exports:
`parsePrUrl(s): PrRef|null`, `loadPr(ref): Promise<PrData>`, `refreshPr(ref): Promise<Pick<PrData,'headOid'|'threads'|'pendingReviewId'> & {viewed: Map<string,ViewedState>}>`,
`fetchBlobs(ref, specs: {commit:string, path:string}[]): Promise<Map<string /* commit:path */, BlobResult>>` (cache-aware),
`setViewed(prId, items: {path:string, viewed:boolean}[])`, `ensurePendingReview(pr): Promise<string>`,
`addThread(reviewId, {path, body, line?, side?, startLine?, startSide?, subjectType})`: Promise<Thread>,
`replyThread(reviewId, threadId, body): Promise<Comment>`, `updateComment(id, body)`, `deleteComment(id)`,
`resolveThread(id, resolved)`, `submitReview(reviewId, event, body)`, `discardReview(reviewId)`.

## Plan-review outcomes (Sol @ xhigh, 13 findings, all accepted)

1. Clickjacking: every HTML response sends `Content-Security-Policy: frame-ancestors 'none'` and
   `X-Frame-Options: DENY`.
2. Slow re-diffs and 3. anchor drift: solved by the patch-as-truth model above. The local diff runs only for
   patch-less files, in a Worker with a timeout.
4. Snapshot consistency: `loadPr` records `(baseOid, headOid)` from GraphQL, then re-reads them after REST
   pagination and retries (max 2) if they changed. `refreshPr` applies threads and viewed state **only** if base,
   head and mergeBase are unchanged. Otherwise it shows a "PR changed — reload" banner and applies nothing.
5. Unbounded DOM: rows mount when a file or chunk is within ~1500px of the viewport and **unmount** beyond
   ~5000px, keeping the measured height as a placeholder. Inside a file, items render in lazy chunks of 400 rows,
   so "all" context on a 10k-line file stays cheap.
6. Ranges validated per GitHub hunk (above).
7. Nested pagination: each thread's `comments` gets `pageInfo`. Incomplete threads are drained through
   `node(id:)` queries, on load and on refresh.
8. Line endings/EOF: per-row `cr`/`noEol` (above).
9. Orphan threads (path not in the current file list, after rename aliasing via `previousPath`) are listed
   in an "Other threads" block at the end of the Diff tab and counted in the Overview.
10. Viewed batches: each alias is reconciled on its own (`data.fN` null or an error `path` entry → revert
    that path only). Each path has a sequence number, so a stale response never overwrites a newer toggle.
11. GitHub lists at most 3000 files. If `files.length < changedFiles`, a banner says so, and "mark all"
    style actions say "(listed files only)".
12. Dev: the server accepts `Origin: http://localhost:5173`/`127.0.0.1:5173` only when started with
    `GHR_DEV=1` (`npm run dev` sets it).
13. Hide rules are typed: `{kind:'category', category}` (evaluated via `categorize()`), `{kind:'glob', pattern}`,
    `{kind:'path', path}`.

## Implementation split

1. Claude: scaffold (package.json, vite, tsconfig, `src/types.ts`).
2. codex (medium): `server/server.ts`, `src/lib/{github,diff,categorize,glob,cache}.ts` + vitest tests
   (diff/hunks/patch parse/glob/categorize/github batching with mocked fetch/server guards).
   Runs in parallel with step 3; codex must not touch `src/ui/**`, `src/main.tsx`, `src/styles.css`.
3. Claude: UI (`src/ui/**`, `src/main.tsx`, `src/styles.css`) against the contracts.
4. Integrate. Verify against a real small PR and a real 150-file PR. Check
   timings (load, unified/split toggle, context change) via `performance.now` in agent-browser, plus pdf
   screenshots. Write paths are tested with a pending review on the user's own PR, which is deleted after.
5. codex review @ xhigh of the code. Fix, then commit (local repo, signed, no remote).

## Code-review outcomes (Sol @ xhigh, three passes)

- Pass 1 found 17 bugs. All were fixed (`4896590`). The main ones: mixed REST/GraphQL revisions, comment targets
  stored as row indexes (now (side, line) anchors), stale refreshes erasing fresh writes, reversed viewed writes.
- Pass 2 confirmed 16 fixed and 1 partial, and found 4 regressions (`ce4f682`). The fixes: viewed bookkeeping became
  per-PR and survives a reload, snapshot generations, reconcile after writes.
- Pass 3 confirmed all of those fixed and found 3 narrower races (`d091052`): queued refreshes, pre-reload refresh
  results, new-revision viewed state.
- Each fix has a store test that fails without it (`src/ui/store.test.ts`).

Since the plan: the REST file list truncates large PRs (0/0, no patch), so per-file counts come from GraphQL.
Missing patches come from the whole-PR `.diff` (`/api/diff/...`), fetched after first paint. A cached PR snapshot
in IndexedDB gives ~0.3 s repeat visits (stale-while-revalidate). Overview is an overlay so the diff stream stays
mounted.

## v2 (2026-11-14): highlighting, CI, conversation, URL state, recent PRs, publish

Verified via the `gh` OAuth token: `commits(last:1){nodes{commit{oid statusCheckRollup{state contexts{...on CheckRun|StatusContext}}}}}`
returns check runs and legacy statuses; `comments` (IssueComment) and `reviews(states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED])`
return `viewerCanUpdate/viewerCanDelete`, `url`, `bodyHTML`.

**Routing and URL state** (`src/ui/router.ts`). Client-side routing with `history.pushState`; the Home ↔ PR switch never reloads the page.
- `/` home; `/:o/:r/pull/:n` diff; `/:o/:r/pull/:n/overview`; `/:o/:r/pull/:n/conversation`.
- Query: `only=cat:<category>` or `only=dir:<depth>:<folder>`, `q=<filter>`, `file=<path>`.
- Store → URL by subscription. Push when the PR, tab or focus changes, or when an explicit file jump (sidebar/overview click) flags intent;
  replace when only the filter text or the scroll-spy's current file changed (j/k and scrolling must not flood history).
- popstate → parse → apply to the store with sync suppressed. A different PR → `load()`. A `file` param differing from `current` →
  scroll there; on first load, scroll once the file block exists.
- Global preferences (unified/split, context, font size) stay in localStorage, not the URL: Back must not flip view settings.

**Recent PRs** (`src/lib/recent.ts`). localStorage `ghr:recent`, ≤ 50 entries, most recently opened first. Upsert-and-move-to-front on
each `load()` (opening); metadata (title, state, counts, viewed count, headOid) refreshed in place on later snapshots and viewed
toggles. Home lists them (title → local route, repo#n, author avatar + login, state, files/+/−, viewed progress, opened ago, GitHub ↗,
remove ×) and refreshes them with one aliased GraphQL query (state, isDraft, title, headRefOid, reviewDecision, rollup state), tolerating
per-alias errors; a head oid different from the stored one shows "new commits".

**CI status** (`fetchChecks`). Head commit's rollup + contexts (pages of 100, ≤ 5 pages). Applied only if the returned commit oid equals
`pr.headOid` and the load/revision is still current. Fetched after load, on refresh, and every 30 s while any check is pending and the
tab is visible. Buckets: CheckRun not COMPLETED → pending; SUCCESS/NEUTRAL/SKIPPED → ok; other conclusions → fail. StatusContext
SUCCESS → ok, PENDING/EXPECTED → pending, FAILURE/ERROR → fail. TopBar chip (colour by worst bucket, counts) → popover listing checks,
failing first, with app/workflow, duration and a details link.

**Conversation** (tab, key `t`, overlay like Overview so the diff stays mounted). PR description, issue comments and submitted reviews
merged by time. Reviews with an empty body and state COMMENTED are omitted (containers of inline comments). Composer posts
immediately with `addComment(subjectId: pr.id)` (labelled as such, separate from the draft review). Edit/delete own comments with
`updateIssueComment` / `deleteIssueComment`. Optimistic temp entry; a fetched conversation is applied only when no conversation write
is in flight and none completed since the fetch started; otherwise it is refetched once writes settle. Comments/reviews paginate
(≤ 10 pages of 100).

**Syntax highlighting** (lowlight 3 = highlight.js 11 `common` languages + a few extras, in `src/lib/hl.worker.ts`). Per FileModel, the
old stream (ctx + del rows) and the new stream (ctx + add rows) are highlighted as whole texts so multi-line constructs work, then
split into per-line `[length, className][]` tokens; del rows take old-stream tokens, ctx/add rows new-stream tokens. Gaps in
incomplete models are accepted as context breaks. Language from extension/filename; unknown → plain. Skip streams > 512 KB.
Main thread: one job in flight, visible files (a chunk mounted) first, results cached per FileModel (WeakMap) and published through
a subscription so only that file re-renders. Rendering intersects tokens with word-diff segments. Light/dark token palettes as CSS
variables. Setting `highlight` (default on, key `h`).

**Home button**: ⌂ at the left of the TopBar, client-side navigation to `/`.

**Publishing**: public `mitio/gh-review`. Remove organisation-specific references from files and history (rewrite + re-sign), add an
MIT LICENSE, README covering the new features.

### v2 plan-review outcomes (Sol @ xhigh, 9 findings, all accepted)

1. Client-side PR switching made late write completions land on the next PR (A's pending review id installed on B).
   Every write captures the PR key and touches state only if that PR is still open; editors resolve their draft key
   at mount.
2. A → B → A lost viewed-write ordering. Viewed books live in a per-PR map; a book also keeps the newest local state
   per path, which seeds `viewed` when the PR is reopened.
3. A jump target excluded by focus, filter or hide rules never scrolled. Jumps go through `pendingFile`; a file of the
   PR that the stream excludes is `reveal`ed (shown regardless of filters); a path not in the PR toasts and clears.
4. Conversation/check fetches are dropped unless their load and request sequence are still current (already so in
   code; covered by a test).
5. Submitting a review bumps the conversation epoch and refetches it.
6. Context rows carry tokens from both files (`{a, b}`); split view picks by pane, unified uses `a` only for deletions.
7. Highlighting has a 1.5 s deadline per file; past it the worker is replaced and the file stays plain.
8. The CI summary and polling use GitHub's aggregate counts (`checkRunCountsByState`, `statusContextCountsByState`),
   so a capped list can't read green.
9. Conversation loads newest first (`last/before`, ≤ 10 pages each) and says when older items exist.

### v2 code-review outcomes (Sol @ xhigh)

Pass 1, 9 findings, all fixed:
1. Conversation paging declared unused GraphQL variables on later pages (the whole fetch failed past 100 items).
2. Back to an entry whose file equals `current` kept an older jump target; a restored entry now always replaces it.
3. A conversation fetch made stale by a finished write set a retry flag nothing consumed; it now refetches.
4. A successful post cleared text typed while it was in flight.
5. `reveal` outlived Back and later filter/focus/hide changes; both now clear it.
6. Addition-only changes gave the old pane the new file's tokens; the old side is now highlighted on its own.
7. Recent-PR viewed counts missed refreshes and rollbacks.
8. A push dropped the throttled replacement of the entry being left (filter typed just before a tab change).
9. Recent metadata was read when the debounce fired, possibly from the next PR; it is now captured at once.

Pass 2, 3 findings, all fixed:
1. Back to an entry whose (current) file is excluded by its restored filter lost the file; it is re-revealed.
2. A viewed rollback for a PR no longer open didn't correct that PR's recent-PR count; it is shifted by the delta.
3. Line-ending-only changes left deleted rows without tokens; identical texts now map line by line.

Pass 3, 3 findings, fixed by changing approach rather than patching:
1–2. The rollback delta for a closed PR could corrupt a newer revision's count, and a queued snapshot could overwrite
   it. Recent-PR writes are now merged per PR in one debounced queue, and a closed PR's count is recomputed from its
   viewed book (`paths` of the newest snapshot; local intent while a write is pending, else GitHub's state).
3. Back during a same-PR reload skipped re-targeting an excluded file. A restored file is now re-targeted unless it is
   provably on screen: same PR, loaded, already current and in the stream under the restored filters.

Pass 4, 2 findings:
1. Not fixed (known limit): if un-viewing a file fails while a new revision arrived in which GitHub reports it
   `DISMISSED`, the rollback restores the older revision's `VIEWED`. Recording server state for in-flight paths would
   break the "nothing to send if GitHub already has it" check. The next refresh or reopen corrects it.
2. Home could read the recent list before a queued correction was written; Home now flushes the queue on mount.
