import { highlightRows } from './highlight.ts';
import type { Row } from '../types.ts';

self.onmessage = (event: MessageEvent<{ id: number; lang: string; rows: Pick<Row, 'kind' | 'text'>[] }>) => {
  const { id, lang, rows } = event.data;
  let tokens = null;
  try { tokens = highlightRows(rows, lang); } catch { /* unhighlightable */ }
  self.postMessage({ id, tokens });
};
