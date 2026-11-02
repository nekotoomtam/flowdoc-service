"""Fixed one-purpose child: open a target using only delegated non-root credentials."""
import os,sys,socket,array,re,ctypes,signal
root,channel,uid,gid=map(int,sys.argv[1:5]);name=sys.argv[5]
parent=int(sys.argv[6])
if uid<=0 or gid<=0 or not re.fullmatch('worker-[a-f0-9]{32}',name):raise ValueError('opener arguments')
s=socket.socket(fileno=channel)
if os.getppid()!=parent:raise ValueError('opener parent')
os.setgroups([]);os.setgid(gid);os.setuid(uid)
if ctypes.CDLL(None).prctl(1,signal.SIGKILL,0,0,0)!=0 or os.getppid()!=parent:raise ValueError('opener parent death')
with open('/proc/self/status')as f:
 if 'CapEff:\t0000000000000000'not in f.read():raise ValueError('opener capabilities')
fd=os.open(name+'/cgroup.procs',os.O_WRONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=root)
try:s.sendmsg([b'F'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[fd]))])
finally:os.close(fd);s.close()
