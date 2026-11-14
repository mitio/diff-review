import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { getMany, getPr, putMany, putPr } from './cache';
afterEach(()=>vi.unstubAllGlobals());
const blob={text:'hello',binary:false,truncated:false,missing:false};
test('roundtrips values and evicts oldest thousand after cap',async()=>{
  await putMany([['old',blob]]);
  await putMany(Array.from({length:5000},(_,i)=>[`key${i}`,blob] as const));
  expect((await getMany(['old'])).size).toBe(0);
  expect((await getMany(['key4999'])).get('key4999')).toEqual(blob);
});
test('pr snapshots roundtrip',async()=>{
  await putPr('o/r#1',{title:'t'} as any);
  expect(await getPr('o/r#1')).toEqual({title:'t'});
  expect(await getPr('o/r#2')).toBeNull();
});
test('unavailable or broken indexedDB degrades silently',async()=>{
  vi.resetModules();
  const { getMany, putMany, getPr } = await import('./cache');
  vi.stubGlobal('indexedDB',undefined);
  expect(await getPr('x')).toBeNull();
  expect((await getMany(['key'])).size).toBe(0);
  await expect(putMany([['key',blob]])).resolves.toBeUndefined();
  vi.stubGlobal('indexedDB',{open(){throw new Error('blocked');}});
  expect((await getMany(['key'])).size).toBe(0);
  await expect(putMany([['key',blob]])).resolves.toBeUndefined();
});
