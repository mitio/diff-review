export type ViewedState = 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
export type Side = 'LEFT' | 'RIGHT';
export interface PrRef { owner: string; repo: string; number: number }

/** What is being reviewed. Only 'pr' talks to GitHub for comments and viewed state; the rest keep them locally. */
export type ReviewRef =
  | ({ kind: 'pr' } & PrRef)
  /** sha as typed (7-40 hex) */
  | { kind: 'commit'; owner: string; repo: string; sha: string }
  /** refs or shas as typed */
  | { kind: 'compare'; owner: string; repo: string; base: string; head: string }
  /** repo = absolute git toplevel (realpath); range '' = uncommitted changes incl. untracked */
  | { kind: 'local'; repo: string; range: string }
  /** id = sha256 hex of the diff text */
  | { kind: 'paste'; id: string };
export type ReviewKind = ReviewRef['kind'];
export interface User { login: string; avatarUrl: string }

export interface PrFile {
  path: string;
  previousPath?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string;
  viewed: ViewedState;
  /** non-PR sources: identifies this version of the file's change (see unidiff.ts) */
  fingerprint?: string;
}

export interface Comment {
  id: string;
  databaseId?: number;
  body: string;
  bodyHTML: string;
  createdAt: string;
  author: User | null;
  state: 'PENDING' | 'SUBMITTED' | string;
  url: string;
  viewerCanUpdate: boolean;
  viewerCanDelete: boolean;
  reviewId?: string;
}

export interface Thread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  side: Side;
  startSide: Side | null;
  isResolved: boolean;
  isOutdated: boolean;
  subjectType: 'LINE' | 'FILE';
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  viewerCanReply: boolean;
  comments: Comment[];
  /** local threads: the lines the comment was made on */
  quote?: QuoteLine[];
}

export interface PrData {
  ref: ReviewRef;
  id: string;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  author: User | null;
  viewer: User;
  baseRefName: string;
  headRefName: string;
  baseOid: string;
  headOid: string;
  mergeBaseOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: PrFile[];
  threads: Thread[];
  pendingReviewId: string | null;
  /** non-PR sources: GitHub listed only part of the files and the full .diff was unavailable */
  truncated?: boolean;
}

export type RefreshResult =
  | { changed: true; baseOid: string; headOid: string }
  | {
      changed: false;
      threads: Thread[];
      viewed: Record<string, ViewedState>;
      pendingReviewId: string | null;
    };

export interface BlobResult { text: string | null; binary: boolean; truncated: boolean; missing: boolean }
export interface BlobSpec { commit: string; path: string }

/** One diff line. `hunk` = index of the GitHub patch hunk it belongs to (=> commentable). */
export interface Row {
  kind: 'ctx' | 'del' | 'add';
  oldNo?: number;
  newNo?: number;
  text: string;
  hunk?: number;
  noEol?: true;
  cr?: true;
}
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  rows: Row[];
}
export interface ParsedPatch { hunks: Hunk[] }

/** complete = every line of the file is present (gaps filled from the blob, or added/removed file). */
export interface FileModel { rows: Row[]; complete: boolean }

/** Inclusive row-index ranges the user explicitly revealed. */
export type Expansions = Array<[number, number]>;

export type Item =
  | { kind: 'row'; idx: number }
  /** rows [from, to] hidden; from/to are row indexes when expandable, else -1. count may be -1 (unknown). */
  | { kind: 'gap'; from: number; to: number; count: number; expandable: boolean };

export type SplitItem =
  | { kind: 'pair'; left: number | null; right: number | null }
  | Extract<Item, { kind: 'gap' }>;

export interface Seg { text: string; changed: boolean }

export type Category = 'generated' | 'tests' | 'migrations' | 'docs' | 'config' | 'styles' | 'source';

export type HideRule =
  | { kind: 'category'; category: Category }
  | { kind: 'glob'; pattern: string }
  | { kind: 'path'; path: string };

export interface GroupSummary {
  key: string;
  files: PrFile[];
  additions: number;
  deletions: number;
  viewed: number;
  hidden: number;
}

export interface TreeNode {
  /** display name; compacted single-child chains joined with '/' */
  name: string;
  /** full dir path (no trailing slash) or file path */
  path: string;
  children: TreeNode[];
  file?: PrFile;
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface NewThread {
  path: string;
  body: string;
  subjectType: 'LINE' | 'FILE';
  line?: number;
  side?: Side;
  startLine?: number;
  startSide?: Side;
  /** local sources: rows startIdx..endIdx of the rendered model */
  quote?: QuoteLine[];
}

export type CheckBucket = 'ok' | 'fail' | 'pending' | 'skipped';
export interface Check {
  name: string;
  /** app or workflow name */
  source: string | null;
  bucket: CheckBucket;
  /** raw status/conclusion for the tooltip */
  detail: string;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  required: boolean;
}
/** `counts` and `state` cover every context, even when `checks` is capped. */
export interface Checks { oid: string; state: string | null; checks: Check[]; total: number; counts: Record<CheckBucket, number> }

export interface IssueComment {
  id: string;
  body: string;
  bodyHTML: string;
  createdAt: string;
  author: User | null;
  url: string;
  viewerCanUpdate: boolean;
  viewerCanDelete: boolean;
}
export interface ReviewSummary {
  id: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | string;
  body: string;
  bodyHTML: string;
  submittedAt: string;
  author: User | null;
  url: string;
}
export interface Conversation {
  body: string;
  bodyHTML: string;
  createdAt: string;
  comments: IssueComment[];
  reviews: ReviewSummary[];
  /** older comments/reviews exist beyond what was loaded (newest first) */
  truncated: boolean;
}

export interface RecentStatus {
  title: string;
  state: string;
  isDraft: boolean;
  headOid: string;
  reviewDecision: string | null;
  ci: string | null;
}

/** One quoted row; 'gap' stands for lines that were not loaded (text ''). */
export interface QuoteLine { kind: 'ctx' | 'del' | 'add' | 'gap'; text: string }

export interface LocalComment { id: string; body: string; createdAt: string; updatedAt?: string }
export interface LocalThread {
  id: string;
  path: string;
  subjectType: 'LINE' | 'FILE';
  side: Side;
  line: number | null;
  startSide: Side | null;
  startLine: number | null;
  /** [] for FILE threads */
  quote: QuoteLine[];
  /** last computed by the UI; read by the CLI export */
  outdated: boolean;
  resolved: boolean;
  comments: LocalComment[];
}
/** Comments and viewed state of a non-PR review, stored by the server as JSON. */
export interface ReviewDoc {
  key: string;
  ref: ReviewRef;
  title: string;
  /** 0 = never saved; the server increments it on every PUT */
  version: number;
  updatedAt: string;
  /** path -> PrFile.fingerprint of the version marked viewed */
  viewed: Record<string, string>;
  threads: LocalThread[];
}
export interface ReviewSummaryRow {
  key: string;
  ref: ReviewRef;
  title: string;
  updatedAt: string;
  threads: number;
  /** unresolved */
  open: number;
  viewed: number;
}

/** GET /api/local/diff */
export interface LocalDiff {
  root: string;
  range: string;
  /** the left side actually diffed (commit oid, or the empty tree) */
  baseOid: string;
  /** commit oid, or 'worktree:<16 hex>' */
  headOid: string;
  /** = baseOid */
  mergeBaseOid: string;
  title: string;
  author: { name: string; email: string } | null;
  diff: string;
}
