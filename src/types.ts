export type ViewedState = 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
export type Side = 'LEFT' | 'RIGHT';
export interface PrRef { owner: string; repo: string; number: number }
export interface User { login: string; avatarUrl: string }

export interface PrFile {
  path: string;
  previousPath?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string;
  viewed: ViewedState;
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
}

export interface PrData {
  ref: PrRef;
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
}
