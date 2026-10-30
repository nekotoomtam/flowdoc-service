import {beforeEach,it,expect,vi} from 'vitest';
vi.mock('@flowdoc/core',async original=>({...await original(),loadBundledResources:vi.fn(),loadLibraryFonts:vi.fn()}));
import {loadBundledResources,loadLibraryFonts} from '@flowdoc/core';
import {makeFontSnapshot,snapshotResources} from '../dist/fonts/snapshot.js';
import {publicCode} from '../dist/tasks/public.js';
const snapshot=()=>makeFontSnapshot('definition','input',[],[]);
const unavailable=(path,code='RESOURCE_UNAVAILABLE')=>({ok:false,issues:[{code,path,message:'Private diagnostic /internal/path'}],warnings:[]});
beforeEach(()=>vi.resetAllMocks());
it('reports an unwritable temporary root as safe STORAGE_IO through the public mapper',async()=>{
 loadBundledResources.mockResolvedValue(unavailable('tempRoot'));
 const error=await snapshotResources(snapshot(),'/private/workspace').catch(e=>e);
 expect(error).toMatchObject({code:'STORAGE_IO',path:'tempRoot',message:'Temporary storage is not writable'});
 expect(publicCode(error.code)).toBe('STORAGE_IO');
 expect(JSON.stringify(error)).not.toContain('/internal/path');expect(error.message).not.toContain('Font');
 expect(loadLibraryFonts).not.toHaveBeenCalled();
});
it.each(['manifest','font-regular','runtime'])('preserves the existing font classification for %s failure',async path=>{
 loadBundledResources.mockResolvedValue(unavailable(path));
 await expect(snapshotResources(snapshot(),'/workspace')).rejects.toHaveProperty('code','FONT_CHECK_UNAVAILABLE');
 expect(loadLibraryFonts).not.toHaveBeenCalled();
});
it('does not infer storage failure solely from a tempRoot path on an unrelated error',async()=>{
 loadBundledResources.mockResolvedValue(unavailable('tempRoot','UNRELATED_FAILURE'));
 await expect(snapshotResources(snapshot(),'/workspace')).rejects.toHaveProperty('code','FONT_CHECK_UNAVAILABLE');
});
it('preserves a genuine font hash mismatch after successful bundled-resource loading',async()=>{
 loadBundledResources.mockResolvedValue({ok:true,value:{fonts:[]},warnings:[]});
 const s=makeFontSnapshot('definition','input',[],[{id:'missing-font',sha256:'a'.repeat(64)}]);
 await expect(snapshotResources(s,'/workspace')).rejects.toHaveProperty('code','FONT_ASSET_HASH_MISMATCH');
 expect(loadLibraryFonts).not.toHaveBeenCalled();
});
