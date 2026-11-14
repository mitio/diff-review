import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, gql, rest } from './api';
afterEach(()=>vi.unstubAllGlobals());
test('gql sends guarded JSON and surfaces GitHub errors including partial errors',async()=>{
  const fetcher=vi.fn(async()=>Response.json({data:{a:null},errors:[{message:'Not allowed'}]}));vi.stubGlobal('fetch',fetcher);
  await expect(gql('query {}')).rejects.toThrow('Not allowed');
  expect(await gql('query {}',{}, {allowPartial:true})).toMatchObject({data:{a:null}});
  expect(fetcher.mock.calls[0]).toMatchObject(['/api/graphql',{headers:{'x-ghr':'1','content-type':'application/json'},method:'POST'}]);
});
test('HTTP failures throw ApiError, REST returns pagination link',async()=>{
  vi.stubGlobal('fetch',async()=>Response.json({message:'Forbidden'},{status:403}));
  await expect(rest('repos/o/r/pulls/1')).rejects.toBeInstanceOf(ApiError);
  await expect(gql('q',{}, {allowPartial:true})).rejects.toThrow('Forbidden');
  vi.stubGlobal('fetch',async()=>Response.json([1],{headers:{link:'next'}}));
  expect(await rest('repos/o/r/pulls/1/files')).toEqual({data:[1],link:'next'});
});
