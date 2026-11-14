function compile(pattern: string): string {
  let result = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        while (pattern[i + 1] === '*') i++;
        if (pattern[i + 1] === '/') {
          result += '(?:.*/)?';
          i++;
        } else result += '.*';
      } else result += '[^/]*';
    } else if (char === '?') result += '[^/]';
    else if (char === '{') {
      let depth = 1;
      let end = i + 1;
      const parts: string[] = [];
      let start = end;
      for (; end < pattern.length && depth; end++) {
        if (pattern[end] === '{') depth++;
        else if (pattern[end] === '}') depth--;
        if ((pattern[end] === ',' && depth === 1) || depth === 0) {
          parts.push(pattern.slice(start, end));
          start = end + 1;
        }
      }
      if (depth === 0) {
        result += `(?:${parts.map(compile).join('|')})`;
        i = end - 1;
      } else result += '\\{';
    } else result += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return result;
}

export function globToRegExp(pattern: string): RegExp {
  const rooted = pattern.includes('/');
  const body = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  return new RegExp(`^${rooted ? '' : '(?:.*/)?'}${compile(body)}$`);
}

const regexes = new Map<string, RegExp>();

export function matchGlob(pattern: string, path: string): boolean {
  let regex = regexes.get(pattern);
  if (!regex) {
    regex = globToRegExp(pattern);
    if (regexes.size >= 5000) regexes.delete(regexes.keys().next().value!);
    regexes.set(pattern, regex);
  }
  return regex.test(path);
}
