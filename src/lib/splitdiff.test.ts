import { expect, test } from 'vitest';
import { splitUnifiedDiff } from './diff';

const DIFF = [
  'diff --git a/app/x.rb b/app/x.rb',
  'index 1..2 100644',
  '--- a/app/x.rb',
  '+++ b/app/x.rb',
  '@@ -1,2 +1,2 @@ class X',
  ' a',
  '-b',
  '+c',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  '\\ No newline at end of file',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/old name.md b/new name.md',
  'similarity index 90%',
  'rename from old name.md',
  'rename to new name.md',
  '--- a/old name.md\t',
  '+++ b/new name.md\t',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
  '--- "a/caf\\303\\251.txt"',
  '+++ "b/caf\\303\\251.txt"',
  '@@ -1 +1 @@',
  '--- not a header',
  '++++ also not',
  '',
].join('\n');

test('splits a multi-file git diff into per-path patch bodies', () => {
  const m = splitUnifiedDiff(DIFF);
  expect([...m.keys()]).toEqual(['app/x.rb', 'gone.txt', 'new name.md', 'café.txt']);
  expect(m.get('app/x.rb')).toBe('@@ -1,2 +1,2 @@ class X\n a\n-b\n+c');
  expect(m.get('gone.txt')).toBe('@@ -1 +0,0 @@\n-bye\n\\ No newline at end of file');
  expect(m.get('new name.md')).toBe('@@ -1 +1 @@\n-x\n+y');
  expect(m.get('café.txt')).toBe('@@ -1 +1 @@\n--- not a header\n++++ also not');
});
