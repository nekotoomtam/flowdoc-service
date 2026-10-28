import {createTaskOwnership} from '../dist/tasks/ownership.js';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const owner=await createTaskOwnership(process.env.TASK_OWNER_TEST_ROOT);
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','ignore','ignore','ignore',owner.fenceFd]});await once(child,'spawn');await owner.trackChild(child.pid);
process.send({childPid:child.pid,guardianPid:owner.pid,storageId:owner.storageId});
setInterval(()=>{},1000);
