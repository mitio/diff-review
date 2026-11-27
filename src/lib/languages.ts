/** One token: [length in UTF-16 units, highlight.js class or '']. */
export type Tok = [number, string];

const EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json',
  py: 'python', pyi: 'python', rb: 'ruby', rake: 'ruby', gemspec: 'ruby', ru: 'ruby',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', m: 'objectivec', mm: 'objectivec',
  cs: 'csharp', vb: 'vbnet', php: 'php', pl: 'perl', pm: 'perl', lua: 'lua', r: 'r', ex: 'elixir', exs: 'elixir',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', xsd: 'xml', plist: 'xml',
  erb: 'erb', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'bash',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf', diff: 'diff', patch: 'diff', mk: 'makefile',
  dockerfile: 'dockerfile', tf: 'hcl', tfvars: 'hcl', hcl: 'hcl', tfbackend: 'hcl', nomad: 'hcl',
};
const NAMES: Record<string, string> = {
  dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', gemfile: 'ruby', rakefile: 'ruby',
  guardfile: 'ruby', podfile: 'ruby', vagrantfile: 'ruby', brewfile: 'ruby', '.bashrc': 'bash', '.zshrc': 'bash',
  'nginx.conf': 'nginx',
};

export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (NAMES[name]) return NAMES[name];
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? EXT[name.slice(dot + 1)] ?? null : null;
}
