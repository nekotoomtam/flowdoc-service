"""Unprivileged direct-child gate: no payload before verified self-placement and GO."""
import sys,os,ctypes,struct,socket,json,re,select,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'broker'))
from worker_protocol import send,receive_fd,receive,encode,decode,start,member
stage='bootstrap'

def control():
 def exact(n):
  b=b''
  while len(b)<n:
   part=os.read(5,n-len(b))
   if not part:raise EOFError()
   b+=part
  return b
 n=struct.unpack('!I',exact(4))[0]
 if not 0<n<=8192:raise ValueError('control size')
 return decode(exact(n))
def status(event,**kw):
 b=json.dumps({'event':event,**kw},separators=(',',':')).encode()+b'\n'
 if len(b)>4096:raise ValueError('status size')
 os.write(6,b)
def claim(c):
 global stage
 stage='claim-connect'
 s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(min(5,c['remainingMs']/1000));s.connect(c['socketPath'])
 if struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]!=0:raise ValueError('broker owner')
 q={'v':1,'id':1,'op':'CLAIM','epoch':c['epoch'],'sequence':c['sequence'],'nonce':c['nonce']};send(s,q)
 r,fds=receive_fd(s)
 stage='claim-reply'
 if not r.get('ok')or r.get('id')!=1 or r.get('v')!=1:raise ValueError('claim reply')
 value=r['result']
 if value['step']!='MIGRATE_SELF'or len(fds)!=1:raise ValueError('claim phase')
 fd=fds[0]
 try:
  if os.get_inheritable(fd):raise ValueError('descriptor inheritance')
  os.write(fd,b'0')
  stage='self-moved'
 finally:os.close(fd)
 if not re.fullmatch('worker-[a-f0-9]{32}',value['group']):raise ValueError('scope name')
 expected=c['namespaceRoot']+'/'+value['group']
 if member()!=expected:raise ValueError('scope membership')
 cg=Path('/sys/fs/cgroup')/expected.lstrip('/')
 if int((cg/'memory.max').read_text())!=536870912 or int((cg/'memory.swap.max').read_text())!=0:raise ValueError('scope limits')
 stage='placed-ack'
 send(s,{'v':1,'id':1,'op':'PLACED'});reply=receive(s);s.close()
 if not reply.get('ok')or reply.get('id')!=1 or reply['result'].get('step')!='BOUND'or reply['result'].get('group')!=value['group']or reply['result'].get('startTime')!=start(os.getpid()):raise ValueError('placement reply')
 return value['group']
try:
 if not sys.flags.isolated or not sys.flags.no_site:raise ValueError('isolated bootstrap required')
 libc=ctypes.CDLL(None)
 if libc.prctl(4,0,0,0,0)!=0 or libc.prctl(3,0,0,0,0)!=0:raise ValueError('dumpability')
 status('blocked',pid=os.getpid(),startTime=start(os.getpid()))
 stage='control';c=control();keys={'v','socketPath','epoch','sequence','nonce','namespaceRoot','pidNamespace','remainingMs','payload'}
 if not isinstance(c,dict)or set(c)!=keys or c['v']!=1 or os.readlink('/proc/self/ns/pid')!=c['pidNamespace']:raise ValueError('control schema')
 payload=c['payload']
 if set(payload)!={'executable','args','env','ipc','fence'}or not os.path.isabs(payload['executable'])or not isinstance(payload['args'],list)or len(payload['args'])>16 or any(not isinstance(x,str)or len(x)>4096 or '\0'in x for x in payload['args']):raise ValueError('payload schema')
 group=claim(c);status('bound',group=group,pid=os.getpid(),startTime=start(os.getpid()),epoch=c['epoch'],sequence=c['sequence'])
 go=control()
 if go!={'v':1,'op':'GO'}:raise ValueError('GO required')
 if payload['ipc']:os.set_inheritable(3,True)
 else:
  try:os.close(3)
  except OSError:pass
 if payload['fence']:os.set_inheritable(4,True)
 else:
  try:os.close(4)
  except OSError:pass
 env=payload['env']
 # Node creates these two trusted variables when it opens the IPC transport.
 if payload['ipc']:
  if os.environ.get('NODE_CHANNEL_FD')!='3'or os.environ.get('NODE_CHANNEL_SERIALIZATION_MODE')not in ['json','advanced']:raise ValueError('IPC environment')
  env.update({k:os.environ[k]for k in ['NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE']})
 status('exec',pid=os.getpid());os.close(5);os.set_inheritable(6,False)
 os.execve(payload['executable'],[payload['executable'],*payload['args']],env)
except BaseException as e:
 try:status('failed',code='WORKER_GATE_FAILED',stage=stage,reason=str(e)[:80]if type(e)is ValueError else type(e).__name__)
 except OSError:pass
 raise SystemExit(75)
