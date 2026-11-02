"""Operator stop/restart helper; drains only journalled groups in one anchored root."""
import sys,os,re,time,json,argparse
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from worker_protocol import readonly_json,start,exited
from worker_privileges import restrict
from worker_broker import anchor
def reap(root,a,journal,timeout=10):
 if os.fstat(root).st_ino!=a['rootInode']:raise ValueError('root identity')
 j=readonly_json(journal,65536)
 if j.get('instance')!=a['instance']:raise ValueError('journal instance')
 def read(n,f):
  fd=os.open(n+'/'+f,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=root)
  try:return os.read(fd,65536).decode()
  finally:os.close(fd)
 groups=[];pids=[]
 try:
  for x in j['leases']:
   n=x['group']
   if not re.fullmatch('worker-[a-f0-9]{32}',n):raise ValueError('group')
   try:values=read(n,'cgroup.procs')
   except FileNotFoundError:continue
   configured=read(n,'memory.max').strip()=='536870912'and read(n,'memory.swap.max').strip()=='0'
   if not configured:
    # Intent is journalled before mkdir; no placement FD is issued until limits
    # are configured. A crash in that gap leaves only an empty owned directory.
    if not values.strip()and 'populated 0'in read(n,'cgroup.events'):os.rmdir(n,dir_fd=root);continue
    raise ValueError('limits')
   groups.append(n)
   if x.get('pid')and x.get('start'):
    try:
     if start(x['pid'])==x['start']:pids.append((x['pid'],x['start'],os.pidfd_open(x['pid'])))
    except (FileNotFoundError,ProcessLookupError):pass
   for v in values.split():
    pid=int(v)
    try:st=start(pid);fd=os.pidfd_open(pid)
    except (FileNotFoundError,ProcessLookupError):continue
    pids.append((pid,st,fd))
   fd=os.open(n+'/cgroup.kill',os.O_WRONLY|os.O_NOFOLLOW,dir_fd=root)
   try:os.write(fd,b'1')
   finally:os.close(fd)
  end=time.monotonic()+timeout
  while True:
   live=[]
   for pid,st,fd in pids:
    same=False
    try:same=start(pid)==st
    except FileNotFoundError:pass
    if not exited(fd)or same:live.append(pid)
   populated=[n for n in groups if 'populated 0'not in read(n,'cgroup.events')]
   if not live and not populated:break
   if time.monotonic()>=end:raise ValueError('unconfirmed stop')
   time.sleep(.02)
  for n in groups:os.rmdir(n,dir_fd=root)
  return {'empty':True,'reaped':True,'groups':len(groups)}
 finally:
  for _,_,fd in pids:os.close(fd)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root-fd',type=int,required=True);p.add_argument('--anchor',required=True);p.add_argument('--journal',required=True);x=p.parse_args();a=anchor(x.anchor);restrict();print(json.dumps(reap(x.root_fd,a,x.journal)))
