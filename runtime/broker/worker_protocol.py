"""Bounded local protocol shared by broker and unprivileged bootstrap; no renderer."""
import os,socket,struct,json,array,select,time

FRAME_BYTES=8192
def pairs(items):
 out={}
 for key,value in items:
  if key in out:raise ValueError('duplicate key')
  out[key]=value
 return out
def decode(data):return json.loads(data.decode('utf-8'),object_pairs_hook=pairs)
def encode(value):
 b=json.dumps(value,separators=(',',':'),allow_nan=False).encode('utf-8')
 if not 0<len(b)<=FRAME_BYTES:raise ValueError('frame size')
 return struct.pack('!I',len(b))+b
def send(sock,value,fd=None):
 data=encode(value)
 if fd is None:sock.sendall(data)
 else:
  n=sock.sendmsg([data],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[fd]))])
  if n<len(data):sock.sendall(data[n:])
def exact(sock,n,identity=None):
 data=b''
 while len(data)<n:
  if identity is None:b=sock.recv(n-len(data))
  else:
   b,anc,flags,_=sock.recvmsg(n-len(data),socket.CMSG_SPACE(12))
   creds=[struct.unpack('3i',d)for level,t,d in anc if level==socket.SOL_SOCKET and t==socket.SCM_CREDENTIALS]
   if b and(flags&socket.MSG_CTRUNC or creds!=[identity]or len(anc)!=1):raise ValueError('writer identity')
  if not b:raise EOFError()
  data+=b
 return data
def receive(sock,identity=None,peerfd=None,idle=False):
 if idle:
  while True:
   ready,_,_=select.select([sock,peerfd],[],[],1)
   if peerfd in ready:raise EOFError()
   if sock in ready:break
 sock.settimeout(5)
 n=struct.unpack('!I',exact(sock,4,identity))[0]
 if not 0<n<=FRAME_BYTES:raise ValueError('frame size')
 return decode(exact(sock,n,identity))
def receive_fd(sock):
 b,anc,flags,_=sock.recvmsg(FRAME_BYTES+4,socket.CMSG_SPACE(4),socket.MSG_CMSG_CLOEXEC)
 if not b:raise EOFError()
 if flags&(socket.MSG_TRUNC|socket.MSG_CTRUNC):raise ValueError('ancillary truncation')
 while len(b)<4:b+=exact(sock,4-len(b))
 n=struct.unpack('!I',b[:4])[0]
 if not 0<n<=FRAME_BYTES or len(b)>n+4:raise ValueError('frame size')
 if len(b)<n+4:b+=exact(sock,n+4-len(b))
 fds=[]
 try:
  for level,t,data in anc:
   if level!=socket.SOL_SOCKET or t!=socket.SCM_RIGHTS:raise ValueError('ancillary type')
   a=array.array('i');a.frombytes(data);fds.extend(a)
  if len(fds)>1:raise ValueError('ancillary count')
  return decode(b[4:]),fds
 except BaseException:
  for fd in fds:os.close(fd)
  raise
def start(pid):
 with open('/proc/'+str(pid)+'/stat')as f:return f.read().rsplit(')',1)[1].split()[19]
def member(pid='self'):
 with open('/proc/'+str(pid)+'/cgroup')as f:
  text=f.read().strip()
 if not text.startswith('0::'):raise ValueError('cgroup v2 required')
 return text[3:]
def same_pid_namespace(pid,expected):
 """Pinned same-namespace broker/proc view; no cross-UID ns-link/ptrace access.

 NSpid starts at procfs's PID namespace and lists each nested namespace. A
 single entry equal to the visible PID proves membership in that pinned view.
 Refuse ancestor-mounted procfs rather than infer a namespace from raw PID.
 """
 def values(p):
  with open('/proc/'+str(p)+'/status')as f:
   rows=[line for line in f if line.startswith('NSpid:')]
  if len(rows)!=1:raise ValueError('PID namespace status')
  return list(map(int,rows[0].split()[1:]))
 return os.readlink('/proc/self/ns/pid')==expected and values('self')==[os.getpid()]and values(pid)==[pid]
def exited(fd):
 p=select.poll();p.register(fd,select.POLLIN);return bool(p.poll(0))
def readonly_json(path,limit=8192):
 import stat
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode)or s.st_uid!=0 or s.st_mode&0o022:raise ValueError('anchor owner')
  b=os.read(fd,limit+1)
  if len(b)>limit:raise ValueError('anchor size')
  return decode(b)
 finally:os.close(fd)
