"""Reduce the already operator-started helper; never install/escalate a service."""
import ctypes,os
def restrict(broker=False):
 if os.geteuid()!=0:raise ValueError('root operator helper required')
 libc=ctypes.CDLL(None,use_errno=True);allowed={0,5,6,7}if broker else set()
 with open('/proc/self/status')as f:status=f.read()
 bound=int(next(l.split()[1]for l in status.splitlines()if l.startswith('CapBnd:')),16)
 for cap in range(41):
  if cap not in allowed and bound&(1<<cap):
   if libc.prctl(24,cap,0,0,0)!=0:raise ValueError('capability boundary')
 class H(ctypes.Structure):_fields_=[('version',ctypes.c_uint32),('pid',ctypes.c_int)]
 class D(ctypes.Structure):_fields_=[('effective',ctypes.c_uint32),('permitted',ctypes.c_uint32),('inheritable',ctypes.c_uint32)]
 mask=sum(1<<c for c in allowed);h=H(0x20080522,0);d=(D*2)(D(mask,mask,0),D(0,0,0))
 if libc.capset(ctypes.byref(h),d)!=0 or libc.prctl(38,1,0,0,0)!=0:raise ValueError('capability boundary')
