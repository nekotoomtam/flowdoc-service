import {it,expect} from 'vitest';
const api=await import('../dist/uploads/validation.js').catch(()=>({}));
const config=await import('../dist/uploads/config.js').catch(()=>({}));
it('validates manifest keys, bounded sizes and safe URL declarations',()=>{
 expect(api.validateManifest).toBeTypeOf('function');const c=config.readUploadConfig({});
 const input={requestKey:'test',items:[{key:'a',source:'upload',mediaType:'image/png',byteSize:1024}]};
 expect(api.validateManifest(input,c).items).toHaveLength(1);
 for(const invalid of [{...input,items:[...input.items,...input.items]},{...input,items:[{...input.items[0],byteSize:c.fileBytes+1}]},{...input,items:[{key:'a',source:'url',url:'https://user:secret@example.org/a'}]}])expect(()=>api.validateManifest(invalid,c)).toThrow();
 expect(api.validateManifest({...input,items:[{key:'u',source:'url',url:'https://example.org/a.png'}]},c).items[0].source).toBe('url');
});
it('strictly decodes small Base64 and rejects truncated or oversized input',()=>{
 expect(api.decodeBase64).toBeTypeOf('function');expect(api.decodeBase64('aGk=',10).toString()).toBe('hi');
 for(const value of ['aGk','aGk=!!','aGk=\n','!!!!'])expect(()=>api.decodeBase64(value,10)).toThrow();
 expect(()=>api.decodeBase64('aGk=',1)).toThrow();
});
