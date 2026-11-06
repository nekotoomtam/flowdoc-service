import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,lstat,mkdir,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {taskFiles} from '../dist/tasks/files.js';
const task='10000000-0000-4000-8000-000000000001',file='10000000-0000-4000-8000-000000000002';
let root,files;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'flowdoc-task-files-'));files=await taskFiles(root);});
afterEach(async()=>{expect(resolve(root).startsWith(resolve(tmpdir())+sep+'flowdoc-task-files-')).toBe(true);await rm(root,{recursive:true,force:true});});
it('does not create task directories during read-only lookup or missing-file cleanup',async()=>{
 const key=task+'/output/'+file+'.bin';
 expect(await files.path(key)).toBe(join(root,...key.split('/')));
 expect(await files.size(key)).toBe(0);expect(await files.names(task)).toEqual([]);
 await files.remove(key);await files.workspace(task,false);
 expect(await readdir(root)).toEqual([]);
});
it('creates directories for writes and still publishes and removes the exact owned file',async()=>{
 const key=task+'/input/'+file+'.bin.part',h=await files.open(key);await h.writeFile('owned');await h.close();
 const published=await files.publish(key);expect(await files.size(published)).toBe(5);
 expect(await files.names(task)).toEqual([published]);await files.remove(published);
 expect(await files.removeEmptyDirectories(task)).toBe(true);expect(await readdir(root)).toEqual([]);
 expect(await files.removeEmptyDirectories(task)).toBe(true);
});
it('removes an empty task tree including its workspace without recursive deletion',async()=>{
 for(const sub of ['input','normalized','prepared','output','work'])await mkdir(join(root,task,sub),{recursive:true});
 expect(await files.removeEmptyDirectories(task)).toBe(true);await expect(lstat(join(root,task))).rejects.toMatchObject({code:'ENOENT'});
});
it('preserves retained input and unexpected files instead of declaring the tree retired',async()=>{
 const target=join(root,task,'input');await mkdir(target,{recursive:true});await writeFile(join(target,file+'.bin'),'retained');
 expect(await files.removeEmptyDirectories(task)).toBe(false);expect((await lstat(join(target,file+'.bin'))).size).toBe(8);
 await writeFile(join(root,task,'unknown.txt'),'unknown');
 expect(await files.removeEmptyDirectories(task)).toBe(false);expect((await lstat(join(root,task,'unknown.txt'))).size).toBe(7);
});
it('allows overlapping empty-tree retirement and subsequent reads without recreating it',async()=>{
 await files.workspace(task);const results=await Promise.all([files.removeEmptyDirectories(task),files.removeEmptyDirectories(task)]);
 expect(results).toEqual([true,true]);expect(await files.names(task)).toEqual([]);expect(await readdir(root)).toEqual([]);
});
it('rejects an unowned task identifier before attempting retirement',async()=>{
 await expect(files.removeEmptyDirectories('../outside')).rejects.toHaveProperty('code');
});
it('rejects linked task directories and leaves their target untouched',async()=>{
 const outside=join(root,'sentinel');await mkdir(outside);await writeFile(join(outside,'keep'),'safe');
 await symlink(outside,join(root,task),process.platform==='win32'?'junction':'dir');
 await expect(files.names(task)).rejects.toMatchObject({code:'STORAGE_IO'});
 await expect(files.removeEmptyDirectories(task)).rejects.toMatchObject({code:'STORAGE_IO'});
 expect((await lstat(join(outside,'keep'))).size).toBe(4);
});
