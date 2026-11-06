import os,sys,json,struct
def read():
 def exact(n):
  b=b''
  while len(b)<n:
   q=os.read(5,n-len(b))
   if not q:raise EOFError()
   b+=q
  return b
 return json.loads(exact(struct.unpack('!I',exact(4))[0]))
try:
 c=read()
 if sys.argv[1]=='forged':
  st=open('/proc/self/stat').read().rsplit(')',1)[1].split()[19]
  os.write(6,(json.dumps({'event':'bound','group':'worker-'+'f'*32,'pid':os.getpid(),'startTime':st,'epoch':c['epoch'],'sequence':c['sequence']})+'\n').encode())
 while os.read(5,1024):pass
except EOFError:pass
