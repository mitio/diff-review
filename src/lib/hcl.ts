import type { HLJSApi, Language, Mode } from 'highlight.js';

/** HashiCorp Configuration Language (Terraform, Packer, Nomad, …). */
export default function hcl(hljs: HLJSApi): Language {
  const KEYWORDS = {
    keyword: 'for in if else endif endfor',
    literal: 'true false null',
    'variable.language': 'var local module data each count self path terraform',
  };
  const INTERP: Mode = { className: 'subst', begin: /[$%]\{~?/, end: /~?\}/, keywords: KEYWORDS };
  const STRING: Mode = { className: 'string', begin: /"/, end: /"/, illegal: /\n/, contains: [hljs.BACKSLASH_ESCAPE, INTERP] };
  const HEREDOC: Mode = hljs.END_SAME_AS_BEGIN({
    className: 'string',
    begin: /<<-?[ \t]*([A-Za-z_][\w-]*)$/,
    end: /^[ \t]*([A-Za-z_][\w-]*)$/,
    contains: [INTERP],
  });
  const NUMBER: Mode = { className: 'number', begin: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, relevance: 0 };
  const CALL: Mode = { className: 'built_in', begin: /\b[A-Za-z_][\w]*(?:::[\w]+)*(?=\()/, relevance: 0 };
  const EXPR = [STRING, HEREDOC, NUMBER, CALL, hljs.HASH_COMMENT_MODE, hljs.C_LINE_COMMENT_MODE, hljs.C_BLOCK_COMMENT_MODE];
  INTERP.contains = [STRING, NUMBER, CALL];
  return {
    name: 'HCL',
    aliases: ['terraform', 'tf', 'tfvars'],
    keywords: KEYWORDS,
    contains: [
      // a block type: `resource "aws_s3_bucket" "logs" {`
      { className: 'keyword', begin: /(?<=^[ \t]*)[A-Za-z_][\w-]*(?=(?:[ \t]+(?:"[^"\n]*"|[A-Za-z_][\w-]*))*[ \t]*\{)/, relevance: 0 },
      { className: 'attr', begin: /\b[A-Za-z_][\w-]*(?=[ \t]*=(?![=>]))/, relevance: 0 },
      ...EXPR,
    ],
  };
}
