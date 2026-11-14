export interface GqlError { message: string; path?: Array<string | number>; [key: string]: unknown }
export class ApiError extends Error {
  status: number;
  errors: GqlError[];
  constructor(message: string, status = 0, errors: GqlError[] = []) {
    super(message); this.name = 'ApiError'; this.status = status; this.errors = errors;
  }
}
async function read(response: Response): Promise<any> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new ApiError(text || response.statusText, response.status); }
}
export async function gql<T>(query: string, variables?: object, opts?: { allowPartial?: boolean }): Promise<{data: T; errors?: GqlError[]}> {
  const response = await fetch('/api/graphql', { method:'POST', headers:{'x-ghr':'1','content-type':'application/json'}, body:JSON.stringify({query,variables}) });
  const result = await read(response);
  if (!response.ok || (result.errors?.length && !opts?.allowPartial)) {
    throw new ApiError([result.message, ...(result.errors || []).map((e: GqlError) => e.message)].filter(Boolean).join('; ') || `GitHub HTTP ${response.status}`, response.status, result.errors || []);
  }
  return result;
}
export async function rest<T>(path: string): Promise<{data:T; link:string|null}> {
  const response = await fetch(`/api/rest/${path}`, { headers:{'x-ghr':'1'} });
  const data = await read(response);
  if (!response.ok) throw new ApiError(data.message || `GitHub HTTP ${response.status}`, response.status);
  return {data,link:response.headers.get('link')};
}
export async function restText(path: string): Promise<string> {
  const response = await fetch(`/api/diff/${path}`, { headers:{'x-ghr':'1'} });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = JSON.parse(text).message ?? text; } catch { /* plain text */ }
    throw new ApiError(message || `GitHub HTTP ${response.status}`, response.status);
  }
  return text;
}
