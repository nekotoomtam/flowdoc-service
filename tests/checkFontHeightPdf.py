"""Verify real FlowDoc PDFs against stored definitions, selections and font outlines.
Owner: flowdoc-service test tooling; not a renderer or acceptance substitute.
"""
import sys,json,hashlib,io,subprocess,unicodedata,collections,math,re
from pathlib import Path
from pypdf import PdfReader
import pdfplumber
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.boundsPen import BoundsPen
state_path=Path(sys.argv[1]);out=state_path.parent;state=json.loads(state_path.read_text(encoding='utf-8-sig'));config=json.loads((out/'config.json').read_text(encoding='utf-8-sig'))
assert len(state['families'])==7 and sum(len(e['faces'])for e in state['families'])==20
assert state.get('scenariosDone') and state.get('restoreDone')
assert {e['key']for e in state['families']}|{'default-old-pinned','default-new-explicit','retired-original','retired-clone','legacy-sarabun','legacy-sarabun-clone','restored-sarabun'}=={p['name']for p in state['pdfs']}
assert len(state['pdfs'])==14
normal=lambda text: ''.join(unicodedata.normalize('NFKC',text).split())
sha=lambda b:hashlib.sha256(b).hexdigest()
sources={};selections={};errors=[];results=[]
for e in state['families']:
 for f in e['faces']:
  b=Path(f['path']).read_bytes();assert sha(b)==f['sha256'];sources[f['sha256']]={'font':TTFont(io.BytesIO(b)),'family':e['key'],'weight':f['approvedWeight'],'style':f['style'],'path':f['path']};selections[(e['release']['id'],f['approvedWeight'],f['style'])]=f['sha256']
 if e.get('alternative'):selections[(e['alternative']['id'],400,'normal')]=e['faces'][0]['sha256']
legacy={}
for filename,weight,style in [('Sarabun-Regular.ttf',400,'normal'),('Sarabun-Bold.ttf',700,'normal'),('Sarabun-Italic.ttf',400,'italic'),('Sarabun-BoldItalic.ttf',700,'italic')]:
 p=Path(config['serviceRoot'])/'node_modules/@flowdoc/core/assets/fonts'/filename;b=p.read_bytes();h=sha(b);sources.setdefault(h,{'font':TTFont(io.BytesIO(b)),'family':'bundled-sarabun','weight':weight,'style':style,'path':str(p)});legacy[(weight,style)]=h
chars=set(map(ord,'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789บกยสร'))
def signature(font,cp):
 cmap=font.getBestCmap() or {};name=cmap.get(cp)
 if not name:return None
 gs=font.getGlyphSet();pen=DecomposingRecordingPen(gs);gs[name].draw(pen)
 def rounded(v):
  if isinstance(v,(list,tuple)):return [rounded(x) for x in v]
  if isinstance(v,(int,float)):return round(float(v),5)
  return v
 return rounded(pen.value)
def bounds(font,cp):
 name=(font.getBestCmap()or{}).get(cp)
 if not name:return None
 gs=font.getGlyphSet();pen=BoundsPen(gs);gs[name].draw(pen);return pen.bounds
source_sigs={h:{cp:signature(v['font'],cp)for cp in chars}for h,v in sources.items()}
def blocks(definition):
 result=[]
 def visit(n,nodes):
  if n['type']=='text-block':result.append({'text':''.join('\n'if c['type']=='line-break'else c.get('text','')for c in n['children']),'style':n['props']['textStyleId']})
  for key in ['rowIds','cellIds','childIds']:
   for child in n.get(key,[]):visit(nodes[child],nodes)
 for sec in definition['sections']:
  f=sec['source']['fragment']
  for root in f['rootIds']:visit(f['nodes'][root],f['nodes'])
 return result
for item in state['pdfs']:
 try:
  p=Path(item['path']);assert sha(p.read_bytes())==item['sha256'];reader=PdfReader(p);definition=item['definition'];expected=blocks(definition);pdf=pdfplumber.open(p);fontmap={};fontproof=[];page_data=[];allchars=[]
  for page_index,(page,plumber)in enumerate(zip(reader.pages,pdf.pages)):
   for name,ref in page['/Resources']['/Font'].items():
    f=ref.get_object();base=str(f['/BaseFont']).lstrip('/');d=f['/DescendantFonts'][0].get_object()['/FontDescriptor'].get_object();raw=d['/FontFile2'].get_object().get_data();font=TTFont(io.BytesIO(raw));cmap=font.getBestCmap()or{};present=chars&set(cmap);assert len(present)>=8,(item['name'],base,'not enough diagnostic glyphs')
    sigs={cp:signature(font,cp)for cp in present};matches=[h for h,v in sources.items()if font['head'].unitsPerEm==v['font']['head'].unitsPerEm and all(sigs[cp]==source_sigs[h][cp]for cp in present)]
    assert len(matches)==1,(item['name'],base,'ambiguous/wrong embedded outlines',matches);h=matches[0];fontmap[base]={'hash':h,'font':font};fontproof.append({'page':page_index+1,'resource':str(name),'subsetSha256':sha(raw),'sourceSha256':h,'family':sources[h]['family'],'weight':sources[h]['weight'],'style':sources[h]['style'],'comparedGlyphs':len(present)})
   pc=plumber.chars;assert not any('\ufffd'in c['text']for c in pc)
   allchars+=pc
   for c in pc:
    if c['text'].strip():assert -0.1<=c['x0']<=c['x1']<=float(page.mediabox.width)+.1 and -0.1<=c['top']<=c['bottom']<=float(page.mediabox.height)+.1,(item['name'],'page overflow')
   page_data.append({'page':page_index+1,'text':page.extract_text(),'characters':len(pc)})
  raw=''.join(c['text']for c in allchars);wanted=''.join(b['text']for b in expected);assert collections.Counter(normal(raw))==collections.Counter(normal(wanted)),(item['name'],'text mismatch',collections.Counter(normal(wanted))-collections.Counter(normal(raw)),collections.Counter(normal(raw))-collections.Counter(normal(wanted)))
  flattened=[]
  for c in allchars:
   for ch in normal(c['text']):flattened.append((ch,c))
  actual=''.join(ch for ch,c in flattened);offset=0;spanproof=[]
  for block in expected:
   text=normal(block['text']);start=actual.find(text,offset);assert start>=offset,(item['name'],'block missing/order',block['text']);chosen=[c for ch,c in flattened[start:start+len(text)]];style=definition['styles'][block['style']]
   font=style.get('font');h=selections[(font['releaseId'],font['weight'],font['style'])]if font else legacy[(700 if style['fontWeight']=='bold'else 400,style.get('fontStyle','normal'))]
   assert all(fontmap[c['fontname']]['hash']==h for c in chosen),(item['name'],'wrong face',block['style']);assert all(abs(c['size']-style['fontSize']['value'])<1e-5 for c in chosen),(item['name'],'wrong actual pt',block['style']);spanproof.append({'style':block['style'],'pt':style['fontSize']['value'],'sourceSha256':h,'characters':len(chosen)});offset=start+len(text)
  geometry=[]
  family=next((e for e in state['families']if e['key']==item['name']),None)
  if family:
   bos=[c for c in pdf.pages[0].chars if c['text']=='บ'];assert len(bos)==6
   for c,n in zip(bos[1::2],[10,16,24]):
    embedded=fontmap[c['fontname']]['font'];top=bounds(embedded,0x0e1a)[3];assert abs(top-float(family['profile']['topDesign']))<1e-7;ink=top/embedded['head'].unitsPerEm*c['size'];reference=n*.4;assert abs(ink-reference)<1e-5;geometry.append({'referencePt':n,'actualPdfPt':c['size'],'embeddedBoTop':top,'baselineToTopPt':ink,'referenceBaselineToTopPt':reference,'differencePt':ink-reference})
   assert len(reader.pages)==2;assert 'PAGE1-END'in page_data[0]['text']and'PAGE2-END'in page_data[1]['text']
  prefix=out/'renders'/('specimen-'+item['name']);subprocess.run(['pdftoppm','-scale-to','1600','-png',str(p),str(prefix)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);renderpaths=sorted(str(x)for x in prefix.parent.glob(prefix.name+'-*.png')if re.fullmatch(re.escape(prefix.name)+r'-[0-9]+[.]png',x.name));assert len(renderpaths)==len(reader.pages)
  results.append({'name':item['name'],'path':str(p),'sha256':item['sha256'],'status':'PASS','pages':page_data,'renderPaths':renderpaths,'fonts':fontproof,'textSpans':spanproof,'boGeometry':geometry});pdf.close()
 except Exception as ex:errors.append({'name':item['name'],'error':repr(ex)})
report={'status':'FAIL'if errors else'PASS','pdfs':len(results),'pages':sum(len(r['pages'])for r in results),'errors':errors,'results':results};(out/'pdf-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps({'status':report['status'],'pdfs':report['pdfs'],'pages':report['pages'],'errors':errors},ensure_ascii=False));sys.exit(1 if errors else 0)
