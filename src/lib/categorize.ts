import type { Category, GroupSummary, HideRule, PrFile, TreeNode } from '../types.ts';
import { matchGlob } from './glob.ts';

export const CATEGORIES: Category[] = ['generated', 'tests', 'migrations', 'docs', 'config', 'styles', 'source'];

export const CATEGORY_LABELS: Record<Category, string> = {
  generated: 'Generated', tests: 'Tests', migrations: 'Migrations', docs: 'Docs',
  config: 'Config', styles: 'Styles', source: 'Source',
};

const patterns: Record<Exclude<Category, 'source'>, string[]> = {
  generated: [
    '*.lock', '*.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Gemfile.lock',
    'go.sum', 'poetry.lock', 'Cargo.lock', '*.min.*', '*.snap', '*.pb.go', '*_pb2.py',
    '**/generated/**', '**/__generated__/**', 'db/schema.rb', 'db/structure.sql', '*.svg', '**/vendor/**',
  ],
  tests: [
    '**/{spec,test,tests,__tests__}/**', '*_spec.*', '*_test.*', '*.test.*', '*.spec.*',
    'test_*.py', '**/fixtures/**', '**/cassettes/**', '*Test.java', '*Tests.cs', 'spec_helper.rb',
  ],
  migrations: ['db/migrate/**', '**/migrations/**'],
  docs: ['*.md', '*.mdx', '*.rst', '*.txt', 'docs/**'],
  config: [
    '*.yml', '*.yaml', '*.json', '*.toml', '*.ini', 'Dockerfile*', '.github/**', '*.tf', '*.hcl',
    '.*rc', 'Makefile', '.env*', '*.properties', '*.gradle', '*.gradle.kts', 'Gemfile',
  ],
  styles: ['*.css', '*.scss', '*.sass', '*.less'],
};

export function categorize(path: string): Category {
  for (const category of CATEGORIES) {
    if (category !== 'source' && patterns[category].some(pattern => matchGlob(pattern, path))) return category;
  }
  return 'source';
}

export function isHidden(file: PrFile, rules: HideRule[]): boolean {
  return rules.some(rule => {
    if (rule.kind === 'category') return categorize(file.path) === rule.category;
    if (rule.kind === 'glob') return matchGlob(rule.pattern, file.path);
    return file.path === rule.path;
  });
}

export function folderKey(path: string, depth: number): string {
  const dirs = path.split('/').slice(0, -1);
  return dirs.slice(0, Math.max(0, Math.floor(depth))).join('/') || '/';
}

export function summarize(
  files: PrFile[], keyOf: (file: PrFile) => string,
  isViewed: (file: PrFile) => boolean, isHidden: (file: PrFile) => boolean,
): GroupSummary[] {
  const groups = new Map<string, GroupSummary>();
  for (const file of files) {
    const key = keyOf(file);
    let group = groups.get(key);
    if (!group) {
      group = { key, files: [], additions: 0, deletions: 0, viewed: 0, hidden: 0 };
      groups.set(key, group);
    }
    group.files.push(file);
    group.additions += file.additions;
    group.deletions += file.deletions;
    group.viewed += Number(isViewed(file));
    group.hidden += Number(isHidden(file));
  }
  return [...groups.values()];
}

export function buildTree(files: PrFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);
  for (const file of files) {
    const segments = file.path.split('/');
    let parent = root;
    let path = '';
    for (const name of segments.slice(0, -1)) {
      path = path ? `${path}/${name}` : name;
      let dir = dirs.get(path);
      if (!dir) {
        dir = { name, path, children: [] };
        dirs.set(path, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }
    parent.children.push({ name: segments.at(-1)!, path: file.path, children: [], file });
  }
  function compact(node: TreeNode): void {
    for (const child of node.children) {
      while (!child.file && child.children.length === 1 && !child.children[0].file) {
        const only = child.children[0];
        child.name += `/${only.name}`;
        child.path = only.path;
        child.children = only.children;
      }
      compact(child);
    }
    node.children.sort((a, b) => Number(!!a.file) - Number(!!b.file) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  compact(root);
  return root;
}

/** The order the sidebar lists files in, so keyboard stepping and the diff stream follow it. */
export function sidebarOrder(files: PrFile[], grouping: 'tree' | 'category' | 'flat'): PrFile[] {
  if (grouping === 'flat') return files;
  if (grouping === 'category') return CATEGORIES.flatMap(c => files.filter(f => categorize(f.path) === c));
  const out: PrFile[] = [];
  const walk = (n: TreeNode) => { if (n.file) out.push(n.file); n.children.forEach(walk); };
  walk(buildTree(files));
  return out;
}
