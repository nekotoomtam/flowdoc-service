import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const postgres='postgres@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c';
const selectedTests=['task-files','task-intake-retirement','audit-lab','task-intake','task-normalization','task-processing','task-docx-processing','task-output-format-lifecycle','task-output-names','task-queue-profile-integration'].map(n=>'tests/'+n+'.test.mjs');
const projectPattern=/^flowdoc-audit-[a-f0-9]{12}$/;
const subnet='10.253.254.0/28';
const digest=b=>createHash('sha256').update(b).digest('hex');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const inside=(parent,path)=>{const r=relative(resolve(parent),resolve(path));return r!==''&&!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r);};

/** New Compose project only: no existing volumes/networks, host ports or data mounts. */
export function createLabConfig({sourceRoot,project,credentialsFile,dbPassword,authoringToken}){
 assert.match(project,projectPattern);assert.match(dbPassword,/^[a-f0-9]{48}$/);assert.match(authoringToken,/^[a-f0-9]{48}$/);
 const suffix=project.slice('flowdoc-audit-'.length),database='flowdoc_audit_'+suffix;
 const dbUrl='postgresql://flowdoc_audit:'+dbPassword+'@db:5432/'+database;
 const runtimeImage=project+'-runtime:local',verificationImage=project+'-verification:local';
 const api=(name,memory,profile)=>({
  image:runtimeImage,build:{context:sourceRoot,target:'runtime'},init:true,profiles:['proof'],cpus:2,mem_limit:memory,memswap_limit:memory,
  entrypoint:['node','dist/server.js'],
  environment:{DATABASE_URL:dbUrl,HOST:'0.0.0.0',PORT:'3000',EXPORT_OUTPUT_DIR:'/app/output',UPLOAD_STAGING_DIR:'/app/staging',TASK_STORAGE_DIR:'/app/staging/tasks',TASK_CREDENTIALS_FILE:'/run/secrets/task_credentials',AUTHORING_TOKEN:authoringToken,AUTHORING_PRINCIPAL:'audit-owner',...(profile?{TASK_QUEUE_PROFILE:profile}:{} )},
  secrets:['task_credentials'],volumes:['staging:/app/staging','outputs:/app/output'],networks:['private'],
  labels:{'flowdoc.audit.project':project,'flowdoc.audit.profile':name},depends_on:{db:{condition:'service_healthy'}}
 });
 return {
  name:project,
  services:{
   db:{image:postgres,cpus:1,mem_limit:'512m',memswap_limit:'512m',environment:{POSTGRES_USER:'flowdoc_audit',POSTGRES_DB:database,POSTGRES_PASSWORD:dbPassword},volumes:['database:/var/lib/postgresql'],networks:['private'],labels:{'flowdoc.audit.project':project},healthcheck:{test:['CMD-SHELL','pg_isready -U flowdoc_audit -d '+database],interval:'2s',timeout:'3s',retries:30}},
   verification:{image:verificationImage,build:{context:sourceRoot,target:'verification'},init:true,cpus:2,mem_limit:'1g',memswap_limit:'1g',environment:{DATABASE_URL:dbUrl},networks:['private'],labels:{'flowdoc.audit.project':project},depends_on:{db:{condition:'service_healthy'}}},
   api:api('1g','1g'),api4:api('4g','4g','4g-2cpu'),api6:api('6g','6g','6g-2cpu')
  },
  volumes:Object.fromEntries(['database','staging','outputs'].map(n=>[n,{name:project+'_'+n}])),
  networks:{private:{name:project+'_private',internal:true,ipam:{config:[{subnet}]}}},
  secrets:{task_credentials:{file:credentialsFile}}
 };
}

export function validateLabConfig(c,options){
 const {sourceRoot,project,credentialsFile}=options;assert.match(project,projectPattern);
 assert.equal(c.name,project);assert.equal(resolve(credentialsFile),join(resolve(sourceRoot),'artifacts',project,'task-credentials.json'));
 assert.deepEqual(Object.keys(c.services).sort(),['api','api4','api6','db','verification']);
 assert.deepEqual(Object.keys(c.volumes).sort(),['database','outputs','staging']);
 assert.deepEqual(c.secrets,{task_credentials:{file:credentialsFile}});
 assert.deepEqual(c.networks,{private:{name:project+'_private',internal:true,ipam:{config:[{subnet}]}}});
 for(const [name,v]of Object.entries(c.volumes)){assert.equal(v.name,project+'_'+name);assert.ok(!v.external);assert.deepEqual(Object.keys(v),['name']);}
 const database='flowdoc_audit_'+project.slice('flowdoc-audit-'.length);
 assert.equal(c.services.db.environment.POSTGRES_DB,database);assert.equal(c.services.db.environment.POSTGRES_USER,'flowdoc_audit');
 const expectedMounts={db:['database:/var/lib/postgresql'],verification:[],api:['staging:/app/staging','outputs:/app/output'],api4:['staging:/app/staging','outputs:/app/output'],api6:['staging:/app/staging','outputs:/app/output']};
 for(const [name,s]of Object.entries(c.services)){
  assert.ok(!s.ports&&!s.container_name&&!s.network_mode&&!s.privileged&&!s.volumes_from&&!s.env_file);
  assert.deepEqual(s.networks,['private']);assert.deepEqual(s.volumes??[],expectedMounts[name]);
  assert.equal(s.image,name==='db'?postgres:project+(name==='verification'?'-verification:local':'-runtime:local'));
  assert.equal(s.labels['flowdoc.audit.project'],project);
  if(name!=='db'){
   assert.equal(resolve(s.build.context),resolve(sourceRoot));assert.equal(s.build.target,name==='verification'?'verification':'runtime');
   const u=new URL(s.environment.DATABASE_URL);assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'db');assert.equal(u.port,'5432');assert.equal(u.pathname,'/'+database);assert.equal(u.username,'flowdoc_audit');assert.equal(u.password,c.services.db.environment.POSTGRES_PASSWORD);assert.equal(u.search,'');
  }
 }
 assert.equal(c.services.api.mem_limit,'1g');assert.equal(c.services.api4.mem_limit,'4g');assert.equal(c.services.api6.mem_limit,'6g');
 return c;
}

export function validateLabNetworks(config,networks){
 const range=cidr=>{const[address,bits]=cidr.split('/'),parts=address.split('.').map(Number),prefix=Number(bits);assert.equal(parts.length,4);assert.ok(parts.every(n=>Number.isInteger(n)&&n>=0&&n<=255));assert.ok(Number.isInteger(prefix)&&prefix>=0&&prefix<=32);const size=2**(32-prefix),start=Math.floor(parts.reduce((a,b)=>a*256+b,0)/size)*size;return[start,start+size-1];};
 const[a,b]=range(subnet);
 for(const network of networks){
  const own=network.Name===config.networks.private.name&&network.Labels?.['com.docker.compose.project']===config.name;
  for(const entry of network.IPAM?.Config??[]){if(!entry.Subnet||entry.Subnet.includes(':'))continue;const[c,d]=range(entry.Subnet);if(a<=d&&c<=b){assert.ok(own&&entry.Subnet===subnet,'Audit subnet overlaps an existing network; no automatic replacement or pruning');}}
 }
}

async function sourceDigest(){
 const names=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean).sort();
 const hash=createHash('sha256');for(const name of names){assert.ok(inside(root,join(root,name)));hash.update(name+'\0');hash.update(await readFile(join(root,name)));}return hash.digest('hex');
}
function docker(args){return execFileSync('docker',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,maxBuffer:32*1024*1024});}
async function main(){
 const [action,...args]=process.argv.slice(2);assert.ok(['prepare','doctor','build','test','status','start','stop'].includes(action),'Use prepare, doctor, build, test, status, start or stop');
 if(action==='start'){assert.equal(args.length,2,'start requires lab directory and 1g, 4g or 6g');assert.ok(['1g','4g','6g'].includes(args[1]),'Unknown resource profile');}
 else if(action==='test'){assert.ok(args.length>=1,'Pass the lab directory');assert.ok(args.slice(1).every(name=>selectedTests.includes(name)),'Only the listed audit regression files may be selected');}
 else assert.equal(args.length,action==='prepare'?0:1,'Unexpected command arguments');
 let directory,manifest,config;
 if(action==='prepare'){
  assert.equal(args.length,0);const project='flowdoc-audit-'+randomBytes(6).toString('hex');directory=join(root,'artifacts',project);await mkdir(directory,{recursive:false,mode:0o700});
  const credentialsFile=join(directory,'task-credentials.json'),dbPassword=randomBytes(24).toString('hex'),authoringToken=randomBytes(24).toString('hex');
  await save(credentialsFile,[{token:randomBytes(24).toString('hex'),ownerKey:'audit-owner',principalId:'audit-client',docKeys:['audit-fixture'],taskRead:true}]);
  config=createLabConfig({sourceRoot:root,project,credentialsFile,dbPassword,authoringToken});validateLabConfig(config,{sourceRoot:root,project,credentialsFile});
  const configPath=join(directory,'compose.json');await save(configPath,config);await writeFile(join(directory,'compose.env'),'# Isolated audit project. All values are in compose.json.\n',{mode:0o600});
  manifest={version:1,project,sourceRoot:await realpath(root),credentialsFile,configPath,configSha256:digest(await readFile(configPath)),core:await json(join(root,'vendor/manifest.json')),createdAt:new Date().toISOString(),context:'desktop-linux',database:config.services.db.environment.POSTGRES_DB,resources:{volumes:Object.values(config.volumes).map(v=>v.name),network:config.networks.private.name,images:[config.services.api.image,config.services.verification.image]},pending:['F5/F6 PostgreSQL integration','F1 hostname-changing recovery','F2 mixed preflight/native resource accounting','F4 lock-order interleaving']};
  await save(join(directory,'lab.json'),manifest);
 }else{
  assert.ok(args.length>=1,'Pass the exact lab directory printed by prepare');directory=resolve(args[0]);assert.ok(inside(join(root,'artifacts'),directory),'Lab must belong to this workspace');
  manifest=await json(join(directory,'lab.json'));assert.equal(manifest.version,1);assert.match(manifest.project,projectPattern);assert.equal(dirname(manifest.configPath),directory);assert.equal(await realpath(root),manifest.sourceRoot);assert.equal(await realpath(directory),directory);
  assert.equal(digest(await readFile(manifest.configPath)),manifest.configSha256,'Lab config changed; prepare a new lab instead');config=await json(manifest.configPath);
  validateLabConfig(config,{sourceRoot:root,project:manifest.project,credentialsFile:manifest.credentialsFile});
 }
 const prefix=['--context',manifest.context,'compose','--env-file',join(directory,'compose.env'),'--project-directory',root,'-f',manifest.configPath,'--project-name',manifest.project];
 const compose=async(args,label)=>{try{const out=docker([...prefix,...args]);if(label)await writeFile(join(directory,label+'.log'),out,{mode:0o600});return out;}catch(e){if(label)await writeFile(join(directory,label+'.log'),String(e.stdout??'')+'\n'+String(e.stderr??''),{mode:0o600});throw Error('Docker lab action failed: '+(label??args[0]));}};
 const report={action,project:manifest.project,directory,at:new Date().toISOString(),resources:manifest.resources};
 try{
  // Offline Compose parsing is useful even while the Docker daemon is stopped.
  await compose(['config','--quiet'],'config-validation');
  if(action==='prepare')report.status='PREPARED';
  else{
   let osType;try{osType=docker(['--context',manifest.context,'info','--format','{{.OSType}}']).trim();}catch{throw Object.assign(Error('Docker engine unavailable for desktop-linux'),{code:'AUDIT_DOCKER_UNAVAILABLE'});}assert.equal(osType,'linux','This lab requires a Linux Docker engine');
   if(action==='doctor'){report.status='READY';report.sourceDigest=await sourceDigest();}
   if(action==='status'){await compose(['ps','--all','--format','json'],'containers');report.status='INSPECTED';}
   if(action==='stop'){await compose(['stop'],'stop');report.status='STOPPED';}
   if(action==='build'){
    const before=await sourceDigest();await compose(['build','verification','api'],'build');assert.equal(await sourceDigest(),before,'Source changed while building');
    const ids=docker(['--context',manifest.context,'image','inspect',...manifest.resources.images,'--format','{{.Id}}']).trim().split(/\r?\n/);
    await save(join(directory,'built.json'),{sourceDigest:before,images:ids});report.status='BUILT';report.sourceDigest=before;
   }
   if(action==='test'||action==='start'){
    const built=await json(join(directory,'built.json'));assert.equal(built.sourceDigest,await sourceDigest(),'Candidate changed; rebuild this lab');
    assert.deepEqual(docker(['--context',manifest.context,'image','inspect',...manifest.resources.images,'--format','{{.Id}}']).trim().split(/\r?\n/),built.images,'Lab image changed; rebuild');
    const networkIds=docker(['--context',manifest.context,'network','ls','-q']).trim().split(/\r?\n/).filter(Boolean);
    validateLabNetworks(config,networkIds.length?JSON.parse(docker(['--context',manifest.context,'network','inspect',...networkIds])):[]);
    await compose(['up','-d','--wait','db'],'database-start');
    if(action==='test'){
     const selection=args.length>1?args.slice(1):selectedTests;report.selection=selection;
     try{const text=await compose(['run','--rm','-T','verification',...selection,'--reporter=json'],'tests');const tests=JSON.parse(text);assert.equal(tests.success,true);assert.equal(tests.numPendingTests,0);report.tests={passed:tests.numPassedTests,failed:tests.numFailedTests,pending:tests.numPendingTests};report.status='PASS';}
     finally{await compose(['stop'],'test-stop');}
    }else{
     assert.equal(args.length,2,'start requires lab directory and 1g, 4g or 6g');const selected={'1g':'api','4g':'api4','6g':'api6'}[args[1]];assert.ok(selected,'Unknown resource profile');
     await compose(['stop','api','api4','api6'],'previous-lab-apis-stop');
     const migration=JSON.parse(await compose(['run','--rm','-T','--entrypoint','node','verification','dist/cli.js','migrate'],'migrate'));assert.equal(migration.ok,true);
     await compose(['up','-d',selected],'probe-api-start');report.status='STARTED';report.profile=args[1];report.apiService=selected;report.access='Internal lab network only; no host port';
    }
   }
  }
 }catch(e){report.status='BLOCKED';report.message=e.code==='AUDIT_DOCKER_UNAVAILABLE'?e.message:e instanceof assert.AssertionError?e.message:'Docker action unavailable or failed; inspect private lab logs';process.exitCode=1;}
 await save(join(directory,action+'-result.json'),report);
 // Never print generated credentials, connection strings or full rendered config.
 console.log(JSON.stringify(report,null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Audit lab failed before execution; check arguments and local prerequisites');process.exitCode=1;});
