import { diffArrays } from 'diff';
import type { Row } from '../types.ts';

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

self.onmessage = (event: MessageEvent<{ id: number; oldText: string; newText: string }>) => {
  const { id, oldText, newText } = event.data;
  try {
    const changes = diffArrays(lines(oldText), lines(newText), { timeout: 3000 });
    if (!changes) { self.postMessage({ id, rows: null }); return; }
    const rows: Row[] = [];
    let oldNo = 1;
    let newNo = 1;
    for (const change of changes) {
      for (const token of change.value) {
        const hasEol = token.endsWith('\n');
        const line = hasEol ? token.slice(0, -1) : token;
        const row: Row = { kind: change.added ? 'add' : change.removed ? 'del' : 'ctx', text: line.endsWith('\r') ? line.slice(0, -1) : line };
        if (line.endsWith('\r')) row.cr = true;
        if (!hasEol) row.noEol = true;
        if (!change.added) row.oldNo = oldNo++;
        if (!change.removed) row.newNo = newNo++;
        rows.push(row);
      }
    }
    self.postMessage({ id, rows });
  } catch { self.postMessage({ id, rows: null }); }
};
