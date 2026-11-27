import { describe, expect, it } from 'vitest';
import { outline } from './outline.ts';
import type { Row } from '../types.ts';

const ctx = (text: string): Row => ({ kind: 'ctx', text });
const rows = (src: string) => src.split('\n').map(ctx);
const heads = (rs: Row[], lang: string | null) => outline(rs, lang).map(e => (e.top ? '(top)' : rs[e.idx].text.trim()));

describe('outline', () => {
  it('lists top-level blocks and nested definitions, not control flow', () => {
    const rs = rows([
      "import {a} from 'b'",
      'import {',
      '  c,',
      "} from 'd'",
      'export class Foo extends Bar {',
      '  private x = 1',
      '  constructor(a: string) {',
      '    super()',
      '  }',
      '  async upload(req: Req): Promise<void> {',
      '    if (x) {',
      '      return',
      '    }',
      '  }',
      '}',
      'export function run(r: X) {',
      '  for (const y of r) {',
      '    useIt(() => {',
      '    })',
      '  }',
      '}',
      "describe('x', () => {",
      "  it('works', () => {",
      '    expect(1)',
      '  })',
      '})',
    ].join('\n'));
    expect(heads(rs, 'typescript')).toEqual([
      '(top)',
      'export class Foo extends Bar {',
      'constructor(a: string) {',
      'async upload(req: Req): Promise<void> {',
      'export function run(r: X) {',
      "describe('x', () => {",
      "it('works', () => {",
    ]);
    expect(outline(rs, 'typescript').map(e => e.depth)).toEqual([0, 0, 1, 1, 0, 0, 1]);
  });

  it('handles indentation-only languages', () => {
    const py = rows('import os\nclass Foo(Bar):\n    def method(self, x):\n        if x:\n            pass\n\nasync def top(a):\n    return 1');
    expect(heads(py, 'python')).toEqual(['(top)', 'class Foo(Bar):', 'def method(self, x):', 'async def top(a):']);
    const rb = rows('module M\n  class Foo < Bar\n    def initialize(a)\n      @a = a\n    end\n  end\nend');
    expect(heads(rb, 'ruby')).toEqual(['module M', 'class Foo < Bar', 'def initialize(a)']);
  });

  it('takes Ruby DSL blocks as sections, not blocks on a receiver or inside methods', () => {
    const rb = rows([
      "application_v2 'onetap' do",
      '  architecture :arm64',
      "  env 'common' do",
      '    APP_ENV x',
      '  end',
      "  workers 'web', group: g do",
      "    process 'main' do",
      '      resources do',
      '        cpu 1',
      '      end',
      '    end',
      '  end',
      '  groups.each do |name, o|',
      "    workers 'sidekiq' do",
      '      replicas 2',
      '    end',
      '  end',
      '  def helper',
      '    transaction do',
      '      x',
      '    end',
      '  end',
      'end',
    ].join('\n'));
    expect(heads(rb, 'ruby')).toEqual([
      "application_v2 'onetap' do",
      "env 'common' do",
      "workers 'web', group: g do",
      "process 'main' do",
      'resources do',
      "workers 'sidekiq' do",
      'def helper',
    ]);
  });

  it('uses headings for markdown and shallow keys for data files', () => {
    expect(heads(rows('intro\n# Title\ntext\n  ## indented is not a heading\n## Section\n```\n# in code\n```'), 'markdown'))
      .toEqual(['(top)', '# Title', '## Section']);
    const yml = rows('name: x\non:\n  push:\n    branches:\n      - main\njobs:\n  build:\n    steps: []');
    expect(heads(yml, 'yaml')).toEqual(['(top)', 'on:', 'push:', 'branches:', 'jobs:', 'build:']);
    expect(heads(rows('{\n  "a": {\n    "b": 1\n  },\n  "c": 2\n}'), 'json')).toEqual(['(top)', '"a": {']);
  });

  it('counts changes per section and follows each side for deleted blocks', () => {
    const rs: Row[] = [
      { kind: 'ctx', text: 'function a() {' },
      { kind: 'del', text: '  old()' },
      { kind: 'add', text: '  fresh()' },
      { kind: 'ctx', text: '}' },
      { kind: 'del', text: 'function gone() {' },
      { kind: 'del', text: '  x()' },
      { kind: 'del', text: '}' },
      { kind: 'ctx', text: 'function b() {' },
      { kind: 'ctx', text: '  y()' },
      { kind: 'ctx', text: '}' },
    ];
    expect(outline(rs, 'javascript')).toEqual([
      { idx: 0, end: 3, add: 1, del: 1, depth: 0 },
      { idx: 4, end: 6, add: 0, del: 3, depth: 0 },
      { idx: 7, end: 9, add: 0, del: 0, depth: 0 },
    ]);
  });

  it('ignores lines the caller marks as non-code and finds nested test calls', () => {
    const rs = rows('test("a", async t => {\n  const s = `\nmulti {\n  line\n`\n  await t.test("b", () => {\n    x()\n  })\n  it.each([1])("c", () => {\n    y()\n  })\n})');
    expect(heads(rs, 'javascript')).toEqual(['test("a", async t => {', 'multi {', 'await t.test("b", () => {', 'it.each([1])("c", () => {']);
    expect(outline(rs, 'javascript', i => i === 2 || i === 3).map(e => rs[e.idx].text.trim()))
      .toEqual(['test("a", async t => {', 'await t.test("b", () => {', 'it.each([1])("c", () => {']);
  });

  it('falls back to top-level blocks for unknown languages and returns nothing for empty files', () => {
    expect(heads(rows('a {\n  b {\n    c\n  }\n}'), null)).toEqual(['a {']);
    expect(outline([], 'typescript')).toEqual([]);
  });
});
