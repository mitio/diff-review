import { describe, expect, it } from 'vitest';
import { languageOf, resolveLang, tokenizeLines } from './highlight.ts';

const SRC = [
  '# comment',
  'resource "aws_s3_bucket" "logs" {',
  '  bucket = "${var.name}-logs"',
  '  count  = 2',
  '  tags   = merge(local.tags, { Name = "x" })',
  '  policy = <<EOF',
  '{"a": "${data.x.y}"}',
  'EOF',
  '  dynamic "rule" {',
  '    for_each = var.rules == null ? [] : var.rules',
  '  }',
  '}',
];

function spans(src: string[]) {
  const lines = tokenizeLines(src.join('\n'), 'hcl');
  return src.map((l, i) => {
    let at = 0;
    return lines[i].map(([n, c]) => [l.slice(at, (at += n)), c] as const).filter(([s]) => s.trim());
  });
}

describe('hcl', () => {
  it('is picked for Terraform files and fences', () => {
    expect(languageOf('infra/main.tf')).toBe('hcl');
    expect(languageOf('prod.tfvars')).toBe('hcl');
    expect(languageOf('.terraform.lock.hcl')).toBe('hcl');
    expect(resolveLang('terraform')).toBe('terraform');
    expect(resolveLang('hcl')).toBe('hcl');
  });

  it('marks block types, attributes, strings, interpolation and heredocs', () => {
    const s = spans(SRC);
    const cls = (line: number, text: string) => s[line].find(([t]) => t.trim() === text)?.[1];
    expect(cls(0, '# comment')).toBe('hljs-comment');
    expect(cls(1, 'resource')).toBe('hljs-keyword');
    expect(cls(1, '"aws_s3_bucket"')).toBe('hljs-string');
    expect(cls(2, 'bucket')).toBe('hljs-attr');
    expect(cls(2, 'var')).toBe('hljs-variable language_');
    expect(cls(3, '2')).toBe('hljs-number');
    expect(cls(4, 'merge')).toBe('hljs-built_in');
    expect(cls(4, 'Name')).toBe('hljs-attr');
    expect(s[6].every(([, c]) => c.startsWith('hljs-string') || c.startsWith('hljs-subst') || c.includes('variable'))).toBe(true);
    expect(cls(7, 'EOF')).toBe('hljs-string');
    expect(cls(8, 'dynamic')).toBe('hljs-keyword');
    expect(cls(9, 'for_each')).toBe('hljs-attr');
    expect(cls(9, 'null')).toBe('hljs-literal');
  });
});
