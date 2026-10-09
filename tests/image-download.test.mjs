import {it,expect} from 'vitest';
const api=await import('../dist/images/download.js').catch(()=>({}));
it('accepts only public unicast addresses including IPv6',()=>{
 expect(api.publicAddress).toBeTypeOf('function');
 for(const ip of ['127.0.0.1','10.0.0.2','169.254.169.254','100.64.1.1','192.168.0.1','0.0.0.0','224.0.0.1','::1','::','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1'])expect(api.publicAddress(ip),ip).toBe(false);
 for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])expect(api.publicAddress(ip),ip).toBe(true);
});
it('rejects credentials, non HTTPS, mixed public/private DNS and private redirects before connection',async()=>{
 expect(api.resolveImageUrl).toBeTypeOf('function');
 const dns=async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}];
 for(const url of ['http://example.com/a','https://u:p@example.com/a','https://127.0.0.1/a','https://example.com/a'])await expect(api.resolveImageUrl(url,dns)).rejects.toThrow();
 const r=await api.resolveImageUrl('https://example.com/a',async()=>[{address:'8.8.8.8',family:4}]);expect(r.address).toBe('8.8.8.8');
});
