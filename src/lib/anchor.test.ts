import { expect, test } from 'vitest';
import type { FileModel, Thread } from '../types';
import { anchorStatus, locateThread, quoteRows } from './anchor';
const model = (texts: string[], complete = true): FileModel => ({complete,rows:texts.map((text,i) => ({kind:'ctx',text,oldNo:i+1,newNo:i+1}))});
function thread(fields: Partial<Thread> = {}): Thread {
  return {id:'t',path:'x',line:2,startLine:1,originalLine:null,side:'RIGHT',startSide:null,isResolved:false,isOutdated:false,subjectType:'LINE',viewerCanResolve:true,viewerCanUnresolve:false,viewerCanReply:true,comments:[],quote:[{kind:'ctx',text:'a'},{kind:'ctx',text:'b'}],...fields};
}

test('exact quotes end at their stored end, including LEFT and mixed-side ranges', () => {
  const m = model(['a','b','c']);
  expect(locateThread(m, thread())).toBe(1);
  expect(anchorStatus(m, thread())).toBe('ok');
  expect(locateThread(m, thread({side:'LEFT',startSide:'LEFT'}))).toBe(1);
  const mixed: FileModel = {complete:true,rows:[{kind:'del',text:'old',oldNo:1},{kind:'add',text:'new',newNo:1}]};
  expect(locateThread(mixed, thread({line:1,startLine:1,startSide:'LEFT',quote:[{kind:'del',text:'old'},{kind:'add',text:'new'}]}))).toBe(1);
});

test('complete models relocate the whole quote once, without trusting a matching last row', () => {
  expect(locateThread(model(['above','a','b']), thread())).toBe(2);
  expect(anchorStatus(model(['above','a','b']), thread())).toBe('moved');
  expect(anchorStatus(model(['a','changed','b']), thread())).toBe('outdated');
  expect(locateThread(model(['x','a','b','a','b']), thread())).toBe(-1);
  expect(anchorStatus(model(['x','a','b','a','b']), thread())).toBe('outdated');
});

test('gaps match zero or more rows lazily and cannot swallow a changed quoted line', () => {
  const t = thread({line:4,quote:[{kind:'ctx',text:'a'},{kind:'gap',text:''},{kind:'ctx',text:'b'}]});
  expect(locateThread(model(['a','x','y','b']), t)).toBe(3);
  expect(locateThread(model(['a','b']), t)).toBe(1);
  expect(locateThread(model(['x','a','b','b']), t)).toBe(2);
  expect(locateThread(model(['a','x','c']), t)).toBe(-1);
});

test('quoteRows inserts one gap per missing span and none between deletion/addition rows', () => {
  const m: FileModel = {complete:false, rows:[{kind:'ctx',text:'a',oldNo:1,newNo:1},{kind:'del',text:'b',oldNo:2},{kind:'add',text:'c',newNo:2},{kind:'ctx',text:'z',oldNo:10,newNo:10}]};
  expect(quoteRows(m,0,3)).toEqual([{kind:'ctx',text:'a'},{kind:'del',text:'b'},{kind:'add',text:'c'},{kind:'gap',text:''},{kind:'ctx',text:'z'}]);
  expect(quoteRows({...m,complete:true},0,3)).toHaveLength(4);
  expect(locateThread(m, thread({line:10,quote:quoteRows(m,0,3)}))).toBe(3);
});

test('incomplete models report unknown until stored anchors and quote are verifiable', () => {
  expect(anchorStatus(model(['other','b'],false), thread())).toBe('unknown');
  expect(locateThread(model(['other','b'],false), thread())).toBe(-1);
  expect(anchorStatus(model(['a'],false), thread())).toBe('unknown');
  expect(anchorStatus(model(['a','b'],false), thread())).toBe('ok');
});

test('PR threads retain existing coordinate and outdated behavior; local outdated flags can recover', () => {
  expect(locateThread(model(['other','b']), thread({quote:[]}))).toBe(1);
  expect(locateThread(model(['a','b']), thread({quote:undefined,isOutdated:true}))).toBe(-1);
  expect(locateThread(model(['a','b']), thread({subjectType:'FILE',quote:[]}))).toBe(-1);
  expect(locateThread(model(['a','b']), thread({isOutdated:true}))).toBe(1);
});

test('relocation honors the anchor side and exact text', () => {
  const m: FileModel = {complete:true, rows:[{kind:'del',text:'a',oldNo:1},{kind:'add',text:'a',newNo:1}]};
  expect(locateThread(m, thread({line:10,startLine:null,side:'RIGHT',quote:[{kind:'del',text:'a'}]}))).toBe(-1);
  expect(locateThread(model([' a','b']), thread())).toBe(-1);
});

test('large line ranges can be quoted and verified without recursion limits', () => {
  const m = model(Array.from({length:15000}, (_,i) => String(i)));
  const t = thread({startLine:1,line:15000,quote:quoteRows(m,0,14999)});
  expect(locateThread(m,t)).toBe(14999);
});

test('relocating a large repetitive quote does not rescan the whole range per row', () => {
  const m = model(Array.from({length:15000}, () => 'a'));
  const quote = quoteRows(m,0,14999); quote[14999].text = 'b';
  const started = performance.now();
  expect(anchorStatus(m, thread({line:15000,quote}))).toBe('outdated');
  expect(performance.now() - started).toBeLessThan(3000);
});

test('relocation handles overlapping literal prefixes and several lazy gaps', () => {
  expect(locateThread(model(['x','a','a','b']),thread({line:99,quote:[{kind:'ctx',text:'a'},{kind:'ctx',text:'a'},{kind:'ctx',text:'b'}]}))).toBe(3);
  const quote = [{kind:'ctx' as const,text:'a'},{kind:'gap' as const,text:''},{kind:'ctx' as const,text:'b'},{kind:'gap' as const,text:''},{kind:'ctx' as const,text:'c'}];
  expect(locateThread(model(['x','a','b','z','b','c','c']), thread({line:99,quote}))).toBe(5);
  expect(locateThread(model(['a','b','c']), thread({line:3,quote}))).toBe(2);
});
