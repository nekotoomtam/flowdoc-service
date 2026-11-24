from collections import Counter
import re
import unicodedata
from unicodedata import category

import pymupdf


def thai_mark(ch):
    return "\u0e00" <= ch <= "\u0e7f" and category(ch).startswith("M")


def has_detached_mark(text):
    return any(line.strip() and all(thai_mark(ch) for ch in "".join(line.split()))
               for line in text.splitlines())


def read_cell(page, rect, raw):
    if not has_detached_mark(raw):
        return raw
    bounds = pymupdf.Rect(rect)
    blocks = page.get_text("dict", clip=bounds + (-.5, -1, .5, 1),
                           flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES)["blocks"]
    lines = []
    for block in blocks:
        for line in block.get("lines", []):
            box = pymupdf.Rect(line["bbox"])
            if bounds.contains((box.tl + box.br) / 2):
                value = "".join(span["text"] for span in line["spans"]).strip()
                if value:
                    # PDFs can paint a label repeatedly before painting its full line.
                    matching = [i for i, (prev, text) in enumerate(lines)
                                if abs(prev.x0 - box.x0) < .2 and abs(prev.y0 - box.y0) < .2
                                and (value.startswith(text) or text.startswith(value))]
                    if matching:
                        i = matching[0]
                        if len(value) > len(lines[i][1]):
                            lines[i] = box, value
                    else:
                        lines.append((box, value))
    native = [text for _, text in lines]
    candidate = restore_spacing(raw, native)
    if not same_glyphs(raw, candidate):

        candidate = restore_spacing(raw, measured_cell_text(page, dict(text=raw, rect=rect)).splitlines())
    if not same_glyphs(raw, candidate) and corroborated_marks(page, bounds, raw, candidate):
        return candidate
    if has_detached_mark(candidate) or not same_glyphs(raw, candidate):
        raise ValueError("Native reading does not match the table glyphs")
    return candidate


def restore_spacing(raw, native):
    visible = [line.strip() for line in raw.splitlines()
               if line.strip() and not all(thai_mark(ch) for ch in "".join(line.split()))]

    def skeleton(line):
        return "".join(c for c in line if not c.isspace() and not thai_mark(c))
    if len(native) == len(visible):
        for i, (old_line, new_line) in enumerate(zip(visible, native)):
            if skeleton(old_line) != skeleton(new_line):
                continue
            # A complete original line can already contain all its own marks.
            # Preserve it if native extraction only duplicated an adjacent mark.

            if re.sub(r"([\u0e31\u0e34-\u0e3a\u0e47-\u0e4e])\1+", r"\1", new_line).split() == old_line.split():
                native[i] = old_line
                continue
            # Restore word spaces lost when native overprinted labels touch values.
            gaps = {}
            base_count = 0
            for char in old_line:
                if char.isspace():
                    gaps[base_count] = True
                elif not thai_mark(char):
                    base_count += 1
            result = []
            base_count = 0
            for char in new_line:
                if not char.isspace() and not thai_mark(char):
                    if base_count in gaps and result and not result[-1].isspace():
                        result.append(" ")
                    base_count += 1
                result.append(char)
            native[i] = "".join(result)
    return "\n".join(native)

def same_glyphs(raw, candidate):
    old = "".join(raw.split())
    new = "".join(candidate.split())
    def bases(text):
        return "".join(c for c in text if not thai_mark(c))
    if Counter(old) != Counter(new):
        return False
    if bases(old) == bases(new):
        return True
    # An underscore drawn below its word can also become a separate line.
    # Permit movement only within the immediately preceding source line.
    groups = []
    for line in raw.splitlines():
        if has_detached_mark(line):
            continue
        if line.strip() == "_" and groups:
            groups[-1] += "\n_"
        elif line.strip():
            groups.append(line)
    lines = candidate.splitlines()
    if len(groups) != len(lines):
        return False
    for group, line in zip(groups, lines):
        left = bases("".join(group.split()))
        right = bases("".join(line.split()))
        if group.endswith("\n_"):
            if left.count("_") != right.count("_"):
                return False
            left, right = left.replace("_", ""), right.replace("_", "")
        if left != right:
            return False
    return True




def corroborated_marks(page, bounds, raw, candidate):
    """Require a second engine to corroborate missing marks in the same cell."""
    import math
    import subprocess
    compact = lambda text: "".join(text.split())
    old, new = compact(raw), compact(candidate)
    if (has_detached_mark(candidate) or Counter(old) - Counter(new)
            or not all(thai_mark(c) for c in Counter(new) - Counter(old))
            or "".join(c for c in old if not thai_mark(c)) != "".join(c for c in new if not thai_mark(c))):
        return False
    x, y = math.floor(bounds.x0), math.floor(bounds.y0)
    number = str(page.number + 1)
    args = ["pdftotext", "-f", number, "-l", number, "-r", "72", "-x", str(x),
            "-y", str(y), "-W", str(math.ceil(bounds.x1) - x), "-H", str(math.ceil(bounds.y1) - y),
            "-layout", "-enc", "UTF-8", page.parent.name, "-"]
    try:
        native = subprocess.run(args, check=True, capture_output=True, timeout=15).stdout.decode("utf8")
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return False
    return compact(native) == new
def normalize(s, marks=True):
    allowed='LMN' if marks else 'LN'
    return ''.join(c for c in unicodedata.normalize('NFKC',s).casefold()
                   if unicodedata.category(c)[0] in allowed)

def overlapping_line_groups(blocks):
    """Return contiguous text fragments printed on overlapping coordinates, preferring the complete span."""
    groups=[]
    for b in blocks:
        if groups and abs(groups[-1][0]['rect'][1]-b['rect'][1])<.5:
            prev=groups[-1]
            norm_b=normalize(b['text'])
            if any(min(v['rect'][2],b['rect'][2])-max(v['rect'][0],b['rect'][0])>0
                   and (normalize(v['text']) in norm_b or norm_b in normalize(v['text'])) for v in prev):
                prev.append(b)
                continue
        groups.append([b])
    return groups

def measured_cell_text(page,cell):
    from difflib import SequenceMatcher
    from pymupdf import Rect, TEXTFLAGS_DICT, TEXT_PRESERVE_IMAGES
    rect=Rect(cell['rect'])
    clip=rect+(-.5,-1,.5,1)
    items=[]
    for block in page.get_text('dict',clip=clip,flags=TEXTFLAGS_DICT & ~TEXT_PRESERVE_IMAGES)['blocks']:
        for line in block.get('lines',[]):
            parts=line['spans']
            value=''.join(span['text'] for span in parts).strip()
            x0,y0,x1,y1=line['bbox']
            if value and rect.x0-.5<=(x0+x1)/2<=rect.x1+.5 and rect.y0<=(y0+y1)/2<=rect.y1:
                items.append(dict(text=value,rect=line['bbox']))
    items.sort(key=lambda x:(round(x['rect'][1],1),x['rect'][0]))
    merged='\n'.join(max(group,key=lambda b:len(normalize(b['text'])))['text']
                     for group in overlapping_line_groups(items))
    old=cell['text']
    old_n,new_n=normalize(old,False),normalize(merged,False)
    if old_n and new_n in (old_n*2,old_n*3,old_n*4):
        return old
    if old_n and new_n and SequenceMatcher(None,old_n,new_n,autojunk=False).ratio()>=.78:
        return merged
    return old
