import { expect, test } from 'vitest';
import { parseUnifiedDiff, fingerprint } from './unidiff';
import { parsePatch } from './diff';

test('git metadata preserves rename, copy, binary, modes and empty files', () => {
  const files = parseUnifiedDiff(`diff --git a/old b/new
similarity index 80%
rename from old
rename to new
index aaaaaaa..bbbbbbb 100644
--- a/old
+++ b/new
@@ -1 +1 @@
-old
+new
diff --git a/source b/copy
similarity index 100%
copy from source
copy to copy
diff --git a/gone b/gone
deleted file mode 100644
index aaaaaaa..0000000
--- a/gone
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/empty b/empty
new file mode 100644
index 0000000..e69de29
diff --git a/image b/image
index aaaaaaa..bbbbbbb 100644
Binary files a/image and b/image differ
diff --git a/exec b/exec
old mode 100644
new mode 100755
diff --git a/a b/b
similarity index 100%
rename from a
rename to b
`);
  expect(files.map(f => [f.path, f.previousPath, f.status, f.additions, f.deletions, !!f.patch])).toEqual([
    ['new', 'old', 'renamed', 1, 1, true], ['copy', 'source', 'copied', 0, 0, false],
    ['gone', undefined, 'removed', 0, 1, true], ['empty', undefined, 'added', 0, 0, false],
    ['image', undefined, 'modified', 0, 0, false], ['exec', undefined, 'modified', 0, 0, false],
    ['b', 'a', 'renamed', 0, 0, false],
  ]);
  expect(files.every(f => f.viewed === 'UNVIEWED' && /^[0-9a-f]{16,}$/.test(f.fingerprint!))).toBe(true);
});

test('quoted UTF-8, escaped paths, full oids, CRLF rows and no newline markers', () => {
  const [f] = parseUnifiedDiff('diff --git "a/\\351\\233\\252\\t.txt" "b/\\351\\233\\252\\t.txt"\nindex '+ 'a'.repeat(40)+'..'+'b'.repeat(40)+' 100644\n--- "a/\\351\\233\\252\\t.txt"\n+++ "b/\\351\\233\\252\\t.txt"\n@@ -1 +1 @@\n-old\r\n+new\r\n\\ No newline at end of file\n');
  expect(f.path).toBe('雪\t.txt');
  expect(parsePatch(f.patch!).hunks[0].rows).toMatchObject([{text:'old', cr:true}, {text:'new', cr:true, noEol:true}]);
});

test('plain diff -u, svn separators, multiple files and header-looking content', () => {
  const files = parseUnifiedDiff(`Index: x
===================================================================
--- a/x\t2026-01-01
+++ b/x\t2026-01-02
@@ -1 +1 @@
--- old
+++ new
Index: y
===================================================================
--- a/y
+++ b/y
@@ -0,0 +1 @@
+yes
`);
  expect(files.map(f => [f.path, f.additions, f.deletions])).toEqual([['x',1,1],['y',1,0]]);
  expect(files[0].patch).toBe('@@ -1 +1 @@\n--- old\n+++ new');
});

test('format-patch skips mail headers and trailer; first duplicate wins', () => {
  const one = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
  const files = parseUnifiedDiff('From abc Mon Sep 17 00:00:00 2001\nSubject: [PATCH] A title\n\n---\n x | 2 +-\n'+one+'-- \n2.45.0\n'+one);
  expect(files).toHaveLength(1);
  expect(files[0].patch).toBe('@@ -1 +1 @@\n-a\n+b');
});

test('no-prefix headers and GIT binary patch', () => {
  expect(parseUnifiedDiff('diff --git x y\nold mode 100644\nnew mode 100755\n')[0].path).toBe('y');
  expect(parseUnifiedDiff('diff --git a/x b/x\nGIT binary patch\nliteral 2\nabc\n')[0].patch).toBeUndefined();
});

test('fingerprint includes modes, oids, status, source path and patch', () => {
  const p = {path:'x',status:'modified',oldMode:'100644',newMode:'100644',oldOid:'a',newOid:'b',patch:'p'};
  const base = fingerprint(p);
  for (const delta of [{oldMode:'100755'}, {newMode:'100755'}, {oldOid:'c'}, {newOid:'c'}, {previousPath:'y'}, {patch:'q'}, {status:'added'}, {path:'z'}]) expect(fingerprint({...p,...delta})).not.toBe(base);
  expect(fingerprint({...p})).toBe(base);
});

test('quoted no-prefix header paths work on either side', () => {
  const files = parseUnifiedDiff('diff --git old "new\\tname"\nsimilarity index 100%\ncopy from old\ncopy to "new\\tname"\ndiff --git old "new name"\nold mode 100644\nnew mode 100755\n');
  expect(files.map(f => f.path)).toEqual(['new\tname','new name']);
});

test('unquoted paths with spaces use file markers and quoted renames preserve literal prefixes', () => {
  const [modified, renamed] = parseUnifiedDiff('diff --git a/has b/ inside b/has b/ inside\n--- a/has b/ inside\n+++ b/has b/ inside\n@@ -1 +1 @@\n-a\n+b\ndiff --git "a/a/old\\\\name" "b/b/new\\\\name"\nsimilarity index 100%\nrename from "a/old\\\\name"\nrename to "b/new\\\\name"\n');
  expect(modified.path).toBe('has b/ inside');
  expect(renamed).toMatchObject({path:'b/new\\name',previousPath:'a/old\\name',status:'renamed'});
});

test('new and deleted file counts, binary deletion, and plain /dev/null files', () => {
  const files = parseUnifiedDiff('diff --git a/new b/new\nnew file mode 100644\n--- /dev/null\n+++ b/new\n@@ -0,0 +1,2 @@\n+one\n+two\ndiff --git a/gone b/gone\ndeleted file mode 100644\nBinary files a/gone and /dev/null differ\n--- /dev/null\n+++ b/plain\n@@ -0,0 +1 @@\n+plain\n');
  expect(files.map(f => [f.path,f.status,f.additions,f.deletions,!!f.patch])).toEqual([['new','added',2,0,true],['gone','removed',0,0,false],['plain','added',1,0,true]]);
});

test('parses actual git diff output including copies, renames and binary data', async () => {
  const {execFileSync} = await import('node:child_process');
  const {mkdtemp,writeFile,rename,copyFile,chmod,rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const root = await mkdtemp(join(tmpdir(),'unidiff-'));
  const git = (...args: string[]) => execFileSync('git',['-C',root,...args],{encoding:'utf8'});
  const write = (name: string, text: string) => writeFile(join(root,name),text);
  try {
    git('init','-q'); git('config','user.name','Test'); git('config','user.email','test@example.com');
    git('config','core.autocrlf','false'); git('config','core.quotepath','true'); git('config','core.filemode','true');
    const before = Array.from({length:10},(_,i) => `original line ${i}`).join('\n')+'\n';
    await Promise.all([write('old',before),write('source','copy source\n'),write('gone','delete me\n'),write('雪.txt','before\n'),write('crlf','old\r\n'),write('noeol','old'),write('binary','\0old'),write('exec','#!/bin/sh\n')]);
    git('add','.'); git('commit','-qm','initial');
    await rename(join(root,'old'),join(root,'renamed'));
    await write('renamed',before.replace('line 5','line five'));
    await copyFile(join(root,'source'),join(root,'copy'));
    await rm(join(root,'gone')); await chmod(join(root,'exec'),0o755);
    await Promise.all([write('new','new content\n'),write('雪.txt','after\n'),write('crlf','new\r\n'),write('noeol','new'),write('binary','\0new')]);
    git('add','.');
    const text = git('diff','--cached','--full-index','--find-renames','--find-copies','--find-copies-harder');
    const files = parseUnifiedDiff(text);
    const byPath = new Map(files.map(f => [f.path,f]));
    expect(byPath.get('renamed')).toMatchObject({previousPath:'old',status:'renamed',additions:1,deletions:1});
    expect(byPath.get('copy')).toMatchObject({previousPath:'source',status:'copied',additions:0,deletions:0});
    expect(byPath.get('gone')).toMatchObject({status:'removed',deletions:1});
    expect(byPath.get('new')).toMatchObject({status:'added',additions:1});
    expect(byPath.get('雪.txt')).toMatchObject({status:'modified',additions:1,deletions:1});
    expect(byPath.get('exec')?.patch).toBeUndefined(); expect(byPath.get('binary')?.patch).toBeUndefined();
    expect(parsePatch(byPath.get('crlf')!.patch!).hunks[0].rows.every(r => r.cr)).toBe(true);
    expect(parsePatch(byPath.get('noeol')!.patch!).hunks[0].rows.every(r => r.noEol)).toBe(true);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('mode-only git headers with embedded b/ directories retain the file', () => {
  const files = parseUnifiedDiff('diff --git a/a b/has b/ inside b/a b/has b/ inside\nold mode 100644\nnew mode 100755\n');
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({path:'a b/has b/ inside',status:'modified'});
});
test('treats a blank line inside a hunk as context whose space was stripped', () => {
  const [f] = parseUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n');
  expect(f.patch).toBe('@@ -1,3 +1,3 @@\n a\n \n-b\n+c');
  expect([f.additions, f.deletions]).toEqual([1, 1]);
});
