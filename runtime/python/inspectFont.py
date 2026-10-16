"""Bounded static TrueType inspection. No fetching or modification of source bytes."""
import hashlib
import io
import json
import sys
try:
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
except ImportError:
    pass
from fontTools.ttLib import TTFont

def inspect(path):
    with open(path, 'rb') as stream:
        data = stream.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024 or data[:4] != b'\x00\x01\x00\x00':
        raise ValueError('static TrueType required')
    with TTFont(io.BytesIO(data), lazy=False, checkChecksums=2) as font:
        if any(t in font for t in ('fvar', 'gvar', 'CFF ', 'CFF2')) or not all(t in font for t in ('glyf', 'loca', 'OS/2', 'head', 'name', 'cmap')):
            raise ValueError('unsupported font')
        for tag in font.keys():
            font[tag]  # Force decompilation/checksum checks for every table.
        weight = int(font['OS/2'].usWeightClass)
        if not 1 <= weight <= 1000:
            raise ValueError('weight')
        def name(n):
            value = font['name'].getDebugName(n) or ''
            if len(value) > 8192:
                raise ValueError('oversized name')
            return value
        family = name(16) or name(1)
        if not family:
            raise ValueError('family')
        glyphs = set(font.getGlyphOrder())
        cmap = font.getBestCmap()
        if not cmap:
            raise ValueError('cmap')
        coverage = sorted(cp for cp, glyph in cmap.items() if 0 <= cp <= 0x10ffff and not 0xd800 <= cp <= 0xdfff and glyph != '.notdef' and glyph in glyphs)
        raw_coverage = json.dumps(coverage, separators=(',', ':')).encode('ascii')
        return dict(rawWeight=weight, style='italic' if (font['OS/2'].fsSelection & 1 or font['head'].macStyle & 2) else 'normal',
                    fileVersion=name(5), names=dict(family=family, subfamily=name(17) or name(2), fullName=name(4), postScriptName=name(6), license=name(13), licenseUrl=name(14)),
                    coverage=coverage, coverageDigest=hashlib.sha256(raw_coverage).hexdigest(), sha256=hashlib.sha256(data).hexdigest(), byteLength=len(data))

try:
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=True, separators=(',', ':')))
except Exception:
    # Font parsers can include local paths in exceptions. Never transport those.
    sys.stderr.write('Font inspection failed\n')
    sys.exit(1)
