import {expect,it} from 'vitest';
import {join,resolve} from 'node:path';
const lab=await import('../scripts/auditLab.mjs').catch(()=>({}));
const sourceRoot=resolve('.'),project='flowdoc-audit-0123456789ab',credentialsFile=join(sourceRoot,'artifacts',project,'task-credentials.json');
const options={sourceRoot,project,credentialsFile,dbPassword:'d'.repeat(48),authoringToken:'a'.repeat(48)};
it('provides a dedicated lab configuration and isolation validator',()=>{
 expect(lab.createLabConfig).toBeTypeOf('function');expect(lab.validateLabConfig).toBeTypeOf('function');
});
it('uses only new project-scoped resources with no host ports or source/data bind mounts',()=>{
 const c=lab.createLabConfig(options);expect(()=>lab.validateLabConfig(c,options)).not.toThrow();
 expect(c.services.db.environment.POSTGRES_DB).toBe('flowdoc_audit_0123456789ab');
 for(const service of Object.values(c.services)){expect(service.ports).toBeUndefined();expect(service.container_name).toBeUndefined();}
 for(const volume of Object.values(c.volumes)){expect(volume.external).not.toBe(true);expect(volume.name.startsWith(project+'_')).toBe(true);}
 expect(c.services.api.mem_limit).toBe('1g');expect(c.services.api4.mem_limit).toBe('4g');expect(c.services.api6.mem_limit).toBe('6g');
 expect(c.services.api4.environment.TASK_QUEUE_PROFILE).toBe('4g-2cpu');expect(c.services.api6.environment.TASK_QUEUE_PROFILE).toBe('6g-2cpu');
 expect(c.networks.private.internal).toBe(true);
});
it.each(['volume','bind','port','network','database','credentials','build','image'])('rejects a %s escape before any Docker action',kind=>{
 const c=lab.createLabConfig(options);
 if(kind==='volume')c.volumes.database={name:'real-data',external:true};
 if(kind==='bind')c.services.api.volumes.push('C:/real-data:/app/staging');
 if(kind==='port')c.services.api.ports=['3000:3000'];
 if(kind==='network')c.networks.private={name:'existing',external:true};
 if(kind==='database')c.services.verification.environment.DATABASE_URL='postgresql://user:password@production/flowdoc';
 if(kind==='credentials')c.secrets.task_credentials.file='C:/real-credentials.json';
 if(kind==='build')c.services.verification.build.context='C:/other-repo';
 if(kind==='image')c.services.api.image='flowdoc-service:0.5.2';
 expect(()=>lab.validateLabConfig(c,options)).toThrow();
});
it('uses one explicit subnet and rejects overlap without pruning existing networks',()=>{
 const c=lab.createLabConfig(options);expect(c.networks.private.ipam.config).toEqual([{subnet:'10.253.254.0/28'}]);
 expect(()=>lab.validateLabNetworks(c,[])).not.toThrow();
 expect(()=>lab.validateLabNetworks(c,[{Name:'real-network',IPAM:{Config:[{Subnet:'10.253.0.0/16'}]}}])).toThrow();
 expect(()=>lab.validateLabNetworks(c,[{Name:'other-audit',IPAM:{Config:[{Subnet:'10.253.254.0/28'}]}}])).toThrow();
 expect(()=>lab.validateLabNetworks(c,[{Name:'unrelated',IPAM:{Config:[{Subnet:'10.253.70.0/24'}]}}])).not.toThrow();
});
