import { describe, expect, it } from 'vitest';
import { plainBodyHtml, splitFences } from './mdcode.ts';
import { highlightHtml, resolveLang } from './highlight.ts';

describe('splitFences', () => {
  it('splits prose and fences, keeping the info string', () => {
    expect(splitFences('see:\n```ruby\na = 1\n```\nok')).toEqual([{ text: 'see:' }, { code: 'a = 1', info: 'ruby' }, { text: 'ok' }]);
  });
  it('needs a closing fence of the same char and at least the same length', () => {
    expect(splitFences('~~~~\n```\n~~~\nx\n~~~~~')).toEqual([{ code: '```\n~~~\nx', info: '' }]);
  });
  it('runs an unclosed fence to the end and strips the opening indent', () => {
    expect(splitFences('  ```\n    a\n  b')).toEqual([{ code: '  a\nb', info: '' }]);
  });
  it('leaves inline backticks alone', () => {
    expect(splitFences('```a`b```')).toEqual([{ text: '```a`b```' }]);
  });
});

describe('plainBodyHtml', () => {
  it('escapes and tags fences with their language', () => {
    expect(plainBodyHtml('<b>\n```js x\n1 < 2\n```')).toBe('<span>&lt;b&gt;</span><pre lang="js"><code>1 &lt; 2</code></pre>');
  });
});

describe('resolveLang', () => {
  it('prefers a known info string, then the file, then guessing', () => {
    expect(resolveLang('ruby', 'a.py')).toBe('ruby');
    expect(resolveLang('rb')).toBe('rb');
    expect(resolveLang('tsx')).toBe('tsx');
    expect(resolveLang('suggestion', 'a.py')).toBe('python');
    expect(resolveLang(null, 'a.py')).toBe('python');
    expect(resolveLang(null, 'a.txt')).toBe('auto');
    expect(resolveLang(null)).toBe('auto');
  });
  it('does not guess for a named language it lacks', () => {
    expect(resolveLang('weird', 'a.py')).toBeNull();
  });
});

describe('highlightHtml', () => {
  it('emits escaped highlight.js spans', () => {
    expect(highlightHtml('if a < b then end', 'ruby')).toBe('<span class="hljs-keyword">if</span> a &lt; b <span class="hljs-keyword">then</span> <span class="hljs-keyword">end</span>');
  });
  it('skips unknown, empty and unconvincing guesses', () => {
    expect(highlightHtml('x', null)).toBeNull();
    expect(highlightHtml('  ', 'ruby')).toBeNull();
    expect(highlightHtml('hello there', 'auto')).toBeNull();
  });
  it('guesses an obvious language', () => {
    expect(highlightHtml('def foo(x):\n    return x  # hi\n\nimport os\nprint(os.getcwd())', 'auto')).toContain('hljs-');
  });
});
