import { describe, expect, it } from 'vitest';
import type { PrFile } from '../types.ts';
import { buildTree, categorize, CATEGORIES, folderKey, isHidden, sidebarOrder, summarize } from './categorize.ts';

const file = (path: string, additions = 1, deletions = 2): PrFile => ({ path, additions, deletions, status: 'modified', viewed: 'UNVIEWED' });

describe('categorize', () => {
  it.each([
    ['src/generated/test.ts', 'generated'], ['tests/a.snap', 'generated'], ['vendor/lib.js', 'generated'],
    ['bun.lockb', 'generated'], ['a.min.js.map', 'generated'], ['db/schema.rb', 'generated'],
    ['go.sum', 'generated'], ['logo.svg', 'generated'], ['src/foo_test.go', 'tests'],
    ['src/FooTest.java', 'tests'], ['FooTests.cs', 'tests'], ['spec_helper.rb', 'tests'],
    ['src/tests/a.ts', 'tests'], ['test_a.py', 'tests'], ['src/fixtures/a.json', 'tests'],
    ['db/migrate/001.rb', 'migrations'], ['src/migrations/a.sql', 'migrations'],
    ['docs/index.json', 'docs'], ['README.md', 'docs'], ['.env.local', 'config'],
    ['a.properties', 'config'], ['build.gradle', 'config'], ['Gemfile', 'config'],
    ['package.json', 'config'], ['.github/actions/x', 'config'], ['src/a.scss', 'styles'],
    ['src/a.ts', 'source'],
  ])('%s is %s', (path, category) => expect(categorize(path)).toBe(category));

  it('exports ordered categories', () => {
    expect(CATEGORIES).toEqual(['generated', 'tests', 'migrations', 'docs', 'config', 'styles', 'source']);
  });

  it('evaluates typed hide rules', () => {
    expect(isHidden(file('a.test.ts'), [{ kind: 'category', category: 'tests' }])).toBe(true);
    expect(isHidden(file('src/a.ts'), [{ kind: 'glob', pattern: 'src/**' }])).toBe(true);
    expect(isHidden(file('a.ts'), [{ kind: 'path', path: 'a.ts' }])).toBe(true);
    expect(isHidden(file('b/a.ts'), [{ kind: 'path', path: 'a.ts' }])).toBe(false);
  });

  it('groups by first directory segments', () => {
    expect(folderKey('a/b/c/d.ts', 2)).toBe('a/b');
    expect(folderKey('a/x.ts', 4)).toBe('a');
    expect(folderKey('x.ts', 2)).toBe('/');
  });

  it('summarizes in insertion order using supplied predicates', () => {
    const files = [file('b/a', 4, 2), file('a/a', 3, 5), file('b/b', 1, 1)];
    const groups = summarize(files, f => folderKey(f.path, 1), f => f.path === 'b/a', f => f.path === 'b/b');
    expect(groups).toEqual([
      { key: 'b', files: [files[0], files[2]], additions: 5, deletions: 3, viewed: 1, hidden: 1 },
      { key: 'a', files: [files[1]], additions: 3, deletions: 5, viewed: 0, hidden: 0 },
    ]);
  });

  it('sorts directories first and compacts directory chains without compacting files', () => {
    const files = ['z.ts', 'a/b/c/x.ts', 'many/z.ts', 'many/a.ts', 'a/b/c/y.ts'].map(p => file(p));
    const tree = buildTree(files);
    expect(tree.name).toBe('');
    expect(tree.path).toBe('');
    expect(tree.children.map(n => n.name)).toEqual(['a/b/c', 'many', 'z.ts']);
    expect(tree.children[0].path).toBe('a/b/c');
    expect(tree.children[0].children.map(n => n.name)).toEqual(['x.ts', 'y.ts']);
    expect(tree.children[1].children.map(n => n.name)).toEqual(['a.ts', 'z.ts']);
    expect(buildTree([file('a/b/c.ts')]).children[0].name).toBe('a/b');
    expect(buildTree([]).children).toEqual([]);
  });

  it('orders files as the sidebar lists them', () => {
    const files = ['z.ts', 'a/x.test.ts', 'a/y.ts', 'README.md'].map(p => file(p));
    const order = (g: Parameters<typeof sidebarOrder>[1]) => sidebarOrder(files, g).map(f => f.path);
    expect(order('flat')).toEqual(['z.ts', 'a/x.test.ts', 'a/y.ts', 'README.md']);
    expect(order('tree')).toEqual(['a/x.test.ts', 'a/y.ts', 'README.md', 'z.ts']);
    expect(order('category')).toEqual(['a/x.test.ts', 'README.md', 'z.ts', 'a/y.ts']);
  });
});
