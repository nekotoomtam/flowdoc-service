"""Operator-started scoped cgroup broker. No document data, DB or queue ownership."""
import os,sys,re,time,uuid,socket,struct,threading,subprocess,array,signal,json,argparse,stat
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from worker_protocol import send,receive,start,member,exited,readonly_json,same_pid_namespace
from worker_privileges import restrict

KINDS={'legacy-render','font-preflight','task-render','image-prepare','font-inspect'}
MAX_SEQUENCE=9007199254740991
class Lease:
 def __init__(self,sequence,nonce,kind,remaining_ms,now):
  self.sequence=sequence;self.nonce=nonce;self.kind=kind;self.group='worker-'+uuid.uuid4().hex
  self.deadline=now+remaining_ms/1000;self.arm_deadline=min(self.deadline,now+10);self.state='armed';self.pid=None;self.start=None;self.pidfd=None;self.descendants=[]
 def close(self):
  for fd in ([self.pidfd]if self.pidfd is not None else [])+[x[2]for x in self.descendants]:
   try:os.close(fd)
   except OSError:pass
  self.pidfd=None;self.descendants=[]
class LeaseWindow:
 def __init__(self,max_lease_ms,terminal_limit=128):self.max_lease_ms=max_lease_ms;self.terminal_limit=terminal_limit;self.high_water=0;self.leases={}
 def arm(self,sequence,nonce,kind,remaining_ms,now=None):
  now=time.monotonic()if now is None else now
  if type(sequence)is not int or not 1<=sequence<=MAX_SEQUENCE or not isinstance(nonce,str)or not re.fullmatch('[a-f0-9]{32}',nonce)or kind not in KINDS or type(remaining_ms)is not int or not 1<=remaining_ms<=self.max_lease_ms:raise ValueError('request')
  if sequence in self.leases:
   x=self.leases[sequence]
   if x.nonce!=nonce or x.kind!=kind:raise ValueError('replay')
   return x
  if sequence<=self.high_water:raise ValueError('stale sequence')
  active=[x for x in self.leases.values()if x.state!='stopped']
  if kind=='font-inspect':full=any(x.kind==kind for x in active)
  else:full=sum(x.kind!='font-inspect'for x in active)>=2
  if full:raise ValueError('slots')
  x=Lease(sequence,nonce,kind,remaining_ms,now);self.leases[sequence]=x;self.high_water=sequence;return x
 def expired(self,now=None):
  now=time.monotonic()if now is None else now
  return[x for x in self.leases.values()if x.state!='stopped'and(now>=x.deadline or(x.state=='armed'and now>=x.arm_deadline))]
 def retire(self,sequence):
  self.leases[sequence].state='stopped'
  terminal=[s for s,x in self.leases.items()if x.state=='stopped']
  for s in terminal[:-self.terminal_limit]:self.leases.pop(s).close()

class Broker:
 def __init__(self,root,anchor,socket_path,journal_path):
  self.root=root;self.a=anchor;self.path=Path(socket_path);self.journal=Path(journal_path);self.epoch=uuid.uuid4().hex;self.capability=None
  self.window=LeaseWindow(anchor['maxLeaseMs']);self.lock=threading.RLock();self.registered=False;self.closing=False;self.connections=0
  if os.fstat(root).st_uid!=0 or os.fstat(root).st_ino!=anchor['rootInode']or self.read('','memory.max').strip()!='1073741824':raise ValueError('owned root')
  self.check_coordinator()
  # Old identities cannot be resumed after a daemon restart; reaper must drain first.
  if self.journal.exists():
   old=readonly_json(self.journal,65536)
   if old.get('instance')!=anchor['instance']:raise ValueError('journal instance')
   for x in old['leases']:
    if not re.fullmatch('worker-[a-f0-9]{32}',x['group']):raise ValueError('journal group')
    if not self.empty_group(x['group']):raise ValueError('old scope populated')
    try:os.rmdir(x['group'],dir_fd=root)
    except FileNotFoundError:pass
  self.save()
 def check_coordinator(self):
  a=self.a
  if start(a['coordinatorPid'])!=a['coordinatorStart']or member(a['coordinatorPid'])!=a['coordinatorMember']or not same_pid_namespace(a['coordinatorPid'],a['pidNamespace']):raise ValueError('coordinator identity')
 def read(self,group,file):
  fd=os.open((group+'/'if group else '')+file,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=self.root)
  try:return os.read(fd,65536).decode()
  finally:os.close(fd)
 def write(self,group,file,value):
  fd=os.open(group+'/'+file,os.O_WRONLY|os.O_NOFOLLOW,dir_fd=self.root)
  try:os.write(fd,str(value).encode())
  finally:os.close(fd)
 def empty_group(self,group):
  try:return 'populated 0'in self.read(group,'cgroup.events')
  except FileNotFoundError:return True
 def save(self):
  values=[{'sequence':x.sequence,'group':x.group,'state':x.state,'pid':x.pid,'start':x.start}for x in self.window.leases.values()]
  b=json.dumps({'v':1,'instance':self.a['instance'],'epoch':self.epoch,'leases':values}).encode();tmp=str(self.journal)+'.tmp'
  fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
  try:os.write(fd,b);os.fsync(fd)
  finally:os.close(fd)
  os.replace(tmp,self.journal);d=os.open(self.journal.parent,os.O_DIRECTORY);os.fsync(d);os.close(d)
 def kill(self,x):
  if x.state=='stopped':return
  x.state='stopping';self.save()
  # Capture live descendants before scope kill so zombies are not mistaken for reap.
  if not x.descendants:
   try:
    for value in self.read(x.group,'cgroup.procs').split():
     pid=int(value)
     try:st=start(pid);fd=os.pidfd_open(pid)
     except (FileNotFoundError,ProcessLookupError):continue
     if not exited(fd)and start(pid)==st:x.descendants.append((pid,st,fd))
     else:os.close(fd)
   except FileNotFoundError:pass
  if x.pidfd is not None and not exited(x.pidfd):
   try:signal.pidfd_send_signal(x.pidfd,signal.SIGKILL)
   except ProcessLookupError:pass
  if not self.empty_group(x.group):self.write(x.group,'cgroup.kill',1)
 def stopped(self,x):
  if not self.empty_group(x.group)or(x.pidfd is not None and not exited(x.pidfd)):return False
  for pid,st,fd in x.descendants:
   if not exited(fd):return False
   try:
    if start(pid)==st:return False
   except FileNotFoundError:pass
  try:os.rmdir(x.group,dir_fd=self.root)
  except FileNotFoundError:pass
  self.window.retire(x.sequence);self.save();return True
 def expire(self):
  with self.lock:
   for x in self.window.expired():self.kill(x);self.stopped(x)
 def descriptor(self,group):
  left,right=socket.socketpair();p=None;pidfd=None;received=[];returned=None
  try:
   p=subprocess.Popen([sys.executable,'-I','-S',str(Path(__file__).with_name('worker_fd_opener.py')),str(self.root),str(right.fileno()),str(self.a['openerUid']),str(self.a['openerGid']),group,str(os.getpid())],pass_fds=(self.root,right.fileno()),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   pidfd=os.pidfd_open(p.pid);right.close();left.settimeout(4)
   b,anc,flags,_=left.recvmsg(1,socket.CMSG_SPACE(4),socket.MSG_CMSG_CLOEXEC)
   for level,typ,data in anc:
    if level==socket.SOL_SOCKET and typ==socket.SCM_RIGHTS:
     a=array.array('i');a.frombytes(data);received.extend(a)
   if b!=b'F'or flags&socket.MSG_CTRUNC or len(anc)!=1 or len(received)!=1 or p.wait(timeout=4)!=0:raise ValueError('opener')
   returned=received[0];return returned
  finally:
   right.close();left.close()
   for fd in received:
    if fd!=returned:os.close(fd)
   if p is not None:
    try:
     if p.poll()is None:
      if pidfd is None:raise ValueError('unconfirmed opener identity')
      try:signal.pidfd_send_signal(pidfd,signal.SIGKILL)
      except ProcessLookupError:pass
     p.wait(timeout=4)
    except (OSError,ValueError,subprocess.TimeoutExpired):
     self.closing=True
     if returned is not None:os.close(returned)
     raise ValueError('unconfirmed opener stop')
    finally:
     if pidfd is not None:os.close(pidfd)
 def reply(self,s,id,result=None,code=None,fd=None):
  send(s,{'v':1,'id':id,'ok':code is None,**({'result':result}if code is None else {'code':code})},fd)
 def serve(self,s):
  peerfd=None;control=False;claim=None;request_id=0
  try:
   pid,uid,gid=struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));identity=(pid,uid,gid)
   peerfd=struct.unpack('i',s.getsockopt(socket.SOL_SOCKET,77,4))[0];os.set_inheritable(peerfd,False)
   if uid!=self.a['serviceUid']or gid!=self.a['serviceGid']:raise ValueError('uid')
   while True:
    q=receive(s,identity,peerfd,control);self.expire()
    if not isinstance(q,dict)or q.get('v')!=1 or type(q.get('id'))is not int or not 1<=q['id']<=MAX_SEQUENCE:raise ValueError('schema')
    request_id=q['id'];op=q.get('op');base={'v','id','op'}
    extras={'REGISTER':{'instance'},'ARM':{'epoch','capability','sequence','nonce','kind','remainingMs'},'CLAIM':{'epoch','sequence','nonce'},'COMMIT':{'epoch','capability','sequence'},'CANCEL':{'epoch','capability','sequence'},'WAIT_EMPTY':{'epoch','capability','sequence'}}
    if op not in extras or set(q)!=base|extras[op]:raise ValueError('schema')
    if exited(peerfd):raise ValueError('peer exited')
    with self.lock:
     if op=='REGISTER':
      self.check_coordinator()
      if pid!=self.a['coordinatorPid']or q['instance']!=self.a['instance']or self.registered:raise ValueError('register')
      self.registered=True;control=True;self.capability=uuid.uuid4().hex+uuid.uuid4().hex
      self.reply(s,request_id,{'epoch':self.epoch,'capability':self.capability,'instance':self.a['instance']});continue
     if q['epoch']!=self.epoch or self.closing:raise ValueError('epoch')
     if type(q['sequence'])is not int or not 1<=q['sequence']<=MAX_SEQUENCE:raise ValueError('sequence')
     if op!='CLAIM':
      if not control or q['capability']!=self.capability or self.closing:raise ValueError('session')
      self.check_coordinator()
     if op=='ARM':
      x=self.window.arm(q['sequence'],q['nonce'],q['kind'],q['remainingMs']);self.save();self.reply(s,request_id,{'state':x.state,'group':x.group});continue
     x=self.window.leases.get(q['sequence'])
     if x is None:raise ValueError('sequence')
     if op=='CLAIM':
      if q['nonce']!=x.nonce or int(Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[1])!=self.a['coordinatorPid']or not same_pid_namespace(pid,self.a['pidNamespace']):raise ValueError('claim identity')
      if x.state=='bound'and x.pid==pid and x.start==start(pid)and not exited(x.pidfd):
       self.reply(s,request_id,{'step':'BOUND','group':x.group,'startTime':x.start,'epoch':self.epoch});return
      if x.state!='armed'or time.monotonic()>=x.arm_deadline:raise ValueError('claim state')
      if member(pid)!=self.a['coordinatorMember']:raise ValueError('source scope')
      x.pid=pid;x.start=start(pid);x.pidfd=peerfd;peerfd=None;x.state='binding';claim=x;self.save()
      os.mkdir(x.group,dir_fd=self.root);self.write(x.group,'memory.max',536870912);self.write(x.group,'memory.swap.max',0);self.write(x.group,'memory.oom.group',1)
      os.chown(x.group+'/cgroup.procs',0,self.a['openerGid'],dir_fd=self.root);os.chmod(x.group+'/cgroup.procs',0o620,dir_fd=self.root)
      fd=self.descriptor(x.group)
      try:self.reply(s,request_id,{'step':'MIGRATE_SELF','group':x.group,'epoch':self.epoch},fd=fd)
      finally:os.close(fd)
     elif op=='COMMIT':
      if x.state!='bound'or exited(x.pidfd):raise ValueError('not bound')
      x.state='started';self.save();self.reply(s,request_id,{'state':'started'});continue
     elif op=='CANCEL':self.kill(x);self.reply(s,request_id,{'state':x.state});continue
     elif op=='WAIT_EMPTY':self.reply(s,request_id,{'empty':self.stopped(x)});continue
    ack=receive(s,identity,x.pidfd)
    with self.lock:
     if ack!={'v':1,'id':request_id,'op':'PLACED'}or x.state!='binding'or exited(x.pidfd)or start(pid)!=x.start or str(pid)not in self.read(x.group,'cgroup.procs').split():raise ValueError('placement')
     x.state='bound';self.save()
     try:self.reply(s,request_id,{'step':'BOUND','group':x.group,'startTime':x.start,'epoch':self.epoch})
     except OSError:pass
    return
  except (OSError,ValueError,KeyError,TypeError,EOFError,RecursionError,subprocess.SubprocessError):
   try:self.reply(s,request_id,code='WORKER_BROKER_UNAVAILABLE'if self.closing else 'WORKER_PROTOCOL_ERROR')
   except OSError:pass
   if claim and claim.state=='binding':
    with self.lock:self.kill(claim)
  finally:
   if peerfd is not None:os.close(peerfd)
   s.close()
   with self.lock:
    if control:
     self.closing=True
     for x in self.window.leases.values():self.kill(x)
    self.connections-=1
 def run(self):
  try:self.path.unlink()
  except FileNotFoundError:pass
  listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1);listener.bind(str(self.path));os.chown(self.path,0,self.a['serviceGid']);os.chmod(self.path,0o660);listener.listen(16);listener.settimeout(.5)
  while True:
   self.expire()
   try:s,_=listener.accept()
   except socket.timeout:continue
   with self.lock:
    if self.connections>=16:s.close();continue
    self.connections+=1
   threading.Thread(target=self.serve,args=(s,),daemon=True).start()

def anchor(path):
 a=readonly_json(path);keys={'v','instance','coordinatorPid','coordinatorStart','coordinatorMember','pidNamespace','serviceUid','serviceGid','openerUid','openerGid','rootInode','maxLeaseMs'}
 if not isinstance(a,dict)or set(a)!=keys or a['v']!=1 or not re.fullmatch('[a-f0-9]{32}',a['instance']):raise ValueError('anchor schema')
 for key in ['coordinatorPid','serviceUid','serviceGid','openerUid','openerGid','rootInode','maxLeaseMs']:
  if type(a[key])is not int or a[key]<1:raise ValueError('anchor value')
 if a['openerUid']==a['serviceUid']or a['openerGid']==a['serviceGid']or a['maxLeaseMs']>10800000:raise ValueError('anchor policy')
 return a
def protected_directory(path):
 p=Path(path)
 if not p.is_absolute():raise ValueError('absolute operator path required')
 for q in [p,*p.parents]:
  s=q.lstat()
  if not stat.S_ISDIR(s.st_mode)or s.st_uid!=0 or s.st_mode&0o022:raise ValueError('operator directory')
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--root-fd',type=int,required=True);parser.add_argument('--anchor',required=True);parser.add_argument('--socket',required=True);parser.add_argument('--journal',required=True);args=parser.parse_args()
 for path in [args.anchor,args.socket,args.journal]:protected_directory(Path(path).parent)
 if Path(args.socket).exists()and not stat.S_ISSOCK(Path(args.socket).lstat().st_mode):raise ValueError('socket path occupied')
 a=anchor(args.anchor);restrict(True);Broker(args.root_fd,a,args.socket,args.journal).run()
