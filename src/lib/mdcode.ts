export type Segment = { text: string } | { code: string; info: string };

const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** Splits Markdown into prose and fenced code blocks (CommonMark fences; an unclosed fence runs to the end). */
export function splitFences(md: string): Segment[] {
  const out: Segment[] = [];
  const lines = md.split('\n');
  let text: string[] = [];
  const flush = () => {
    if (text.length) out.push({ text: text.join('\n') });
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]);
    if (!m || (m[2][0] === '`' && m[3].includes('`'))) {
      text.push(lines[i]);
      continue;
    }
    flush();
    const [, indent, fence, info] = m;
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},} *$`);
    const code: string[] = [];
    for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i].replace(new RegExp(`^ {0,${indent.length}}`), ''));
    out.push({ code: code.join('\n'), info: info.trim() });
  }
  flush();
  return out;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A raw Markdown body as HTML: prose stays text, fences become `<pre lang>` blocks for the highlighter. */
export function plainBodyHtml(md: string): string {
  return splitFences(md)
    .map(s => ('code' in s
      ? `<pre${s.info ? ` lang="${escapeHtml(s.info.split(/\s/)[0])}"` : ''}><code>${escapeHtml(s.code)}</code></pre>`
      : `<span>${escapeHtml(s.text)}</span>`))
    .join('');
}
