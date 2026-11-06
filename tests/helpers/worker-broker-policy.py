import sys,os,time
sys.path.insert(0,os.path.abspath('runtime/broker'))
from worker_broker import LeaseWindow
from worker_protocol import same_pid_namespace
assert same_pid_namespace(os.getpid(),os.readlink('/proc/self/ns/pid'))
assert not same_pid_namespace(os.getpid(),'pid:[0]')
w=LeaseWindow(max_lease_ms=60000,terminal_limit=4)
a=w.arm(1,'a'*32,'legacy-render',50000,now=1)
assert w.arm(1,'a'*32,'legacy-render',50000,now=2)is a and a.deadline==51
try:w.arm(1,'b'*32,'legacy-render',50000,now=2);raise AssertionError('nonce replay')
except ValueError:pass
w.arm(2,'b'*32,'legacy-render',50000,now=1)
try:w.arm(3,'c'*32,'legacy-render',50000,now=1);raise AssertionError('slots')
except ValueError:pass
w.retire(1);w.retire(2)
for i in range(3,30):w.arm(i,format(i,'032x'),'legacy-render',50000,now=1);w.retire(i)
assert len(w.leases)==4 and w.high_water==29
try:w.arm(1,'a'*32,'legacy-render',50000,now=2);raise AssertionError('evicted replay')
except ValueError:pass
w.arm(30,'e'*32,'font-inspect',50000,now=1)
try:w.arm(31,'f'*32,'font-inspect',50000,now=1);raise AssertionError('parser slot')
except ValueError:pass
assert w.expired(now=12) and w.expired(now=52)
print('POLICY_PASS')

# A received migration descriptor must close even when its opener wait fails.
from unittest.mock import patch
import worker_broker,socket,array,subprocess
class Endpoint:
 def __init__(self,fd=None):self.fd=fd
 def fileno(self):return 123
 def close(self):pass
 def settimeout(self,n):pass
 def recvmsg(self,*a):return b'F',[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[self.fd]).tobytes())],0,None
class Opener:
 pid=os.getpid()
 returncode=None
 def __init__(self):self.waits=0
 def wait(self,timeout):
  self.waits+=1
  if self.waits==1:raise subprocess.TimeoutExpired('fixed opener',timeout)
  self.returncode=-9;return -9
 def poll(self):return self.returncode
fd=os.open('/dev/null',os.O_RDONLY);op=Opener();b=worker_broker.Broker.__new__(worker_broker.Broker);b.root=0;b.a={'openerUid':65532,'openerGid':65532};b.closing=False
with patch.object(worker_broker.socket,'socketpair',return_value=(Endpoint(fd),Endpoint())),patch.object(worker_broker.subprocess,'Popen',return_value=op),patch.object(worker_broker.signal,'pidfd_send_signal')as killed:
 try:b.descriptor('worker-'+'a'*32)
 except (subprocess.TimeoutExpired,ValueError):pass
 try:os.fstat(fd);raise AssertionError('received descriptor leaked after opener failure')
 except OSError:pass
 assert op.waits>=2,'opener was not reaped'
print('OPENER_CLEANUP_PASS')

# Crash after mkdir but before limit configuration: an empty recorded scope is safe to retire.
import worker_reaper
name='worker-'+'b'*32;contents={};closed=[];removed=[];counter=[8000]
def fake_open(path,*args,**kwargs):
 counter[0]+=1
 values={'cgroup.procs':b'','cgroup.events':b'populated 0\nfrozen 0\n','memory.max':b'max\n','memory.swap.max':b'max\n'}
 contents[counter[0]]=values[str(path).rsplit('/',1)[-1]];return counter[0]
a={'instance':'fixture','rootInode':os.fstat(0).st_ino}
with patch.object(worker_reaper,'readonly_json',return_value={'instance':'fixture','leases':[{'group':name}]}),patch.object(worker_reaper.os,'open',side_effect=fake_open),patch.object(worker_reaper.os,'read',side_effect=lambda fd,n:contents[fd]),patch.object(worker_reaper.os,'close'),patch.object(worker_reaper.os,'rmdir',side_effect=lambda n,**kw:removed.append(n)):
 result=worker_reaper.reap(0,a,'fixture')
 assert result['empty']and removed==[name]
print('PARTIAL_SCOPE_RECOVERY_PASS')
