import {it,expect} from 'vitest';
it('requires explicit complete mappings and returns only trusted identity fields',async()=>{
 const {taskCredentials}=await import('../dist/tasks/config.js');expect(taskCredentials(undefined)).toBeUndefined();
 for(const q of [[],[{token:'short',ownerKey:'o',principalId:'p',docKeys:[],taskRead:true}],[{token:'x'.repeat(40),ownerKey:'o',docKeys:[],taskRead:true}]])expect(()=>taskCredentials(q)).toThrow();
 const resolver=taskCredentials([{token:'x'.repeat(40),ownerKey:'owner',principalId:'service',docKeys:['allowed'],taskRead:true}]);expect(resolver('Bearer '+'x'.repeat(40))).toEqual({ownerKey:'owner',principalId:'service',docKeys:['allowed'],taskRead:true});expect(resolver('Bearer invalid')).toBeNull();
});
