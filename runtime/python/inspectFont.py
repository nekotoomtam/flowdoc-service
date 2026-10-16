"""Bounded static TrueType inspection. No fetching or modification of source bytes."""
import hashlib
import io
import json
import sys
import math
from decimal import Decimal
try:
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
except ImportError:
    pass
from fontTools.ttLib import TTFont
from fontTools import __version__ as fonttools_version
from fontTools.pens.boundsPen import BoundsPen


def height_metric(font, cmap):
    metric = dict(methodId='thai-bo-baseline-top-v1', toolVersion='fontTools/' + fonttools_version,
                  referenceCodePoint=3610, unitsPerEm=int(font['head'].unitsPerEm), baselineDesign='0')
    if not 16 <= metric['unitsPerEm'] <= 16384:
        raise ValueError('unitsPerEm')
    glyph = cmap.get(3610)
    if not glyph or glyph == '.notdef':
        return dict(metric, outcome='unavailable', reason='GLYPH_MISSING', topDesign=None)
    glyphs = font.getGlyphSet()
    pen = BoundsPen(glyphs)
    glyphs[glyph].draw(pen)
    if pen.bounds is None:
        return dict(metric, outcome='unavailable', reason='GLYPH_MISSING', topDesign=None)
    top = pen.bounds[3]
    if not math.isfinite(top) or top <= 0:
        return dict(metric, outcome='unavailable', reason='METRIC_INVALID', topDesign=None)
    decimal = format(Decimal(str(top)), 'f')
    if '.' in decimal:
        decimal = decimal.rstrip('0').rstrip('.')
    return dict(metric, outcome='measured', reason=None, topDesign=decimal)

def inspect(path, include_height=False):
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
        return dict(**(dict(heightMetric=height_metric(font, cmap)) if include_height else {}), rawWeight=weight, style='italic' if (font['OS/2'].fsSelection & 1 or font['head'].macStyle & 2) else 'normal',
                    fileVersion=name(5), names=dict(family=family, subfamily=name(17) or name(2), fullName=name(4), postScriptName=name(6), license=name(13), licenseUrl=name(14)),
                    coverage=coverage, coverageDigest=hashlib.sha256(raw_coverage).hexdigest(), sha256=hashlib.sha256(data).hexdigest(), byteLength=len(data))

try:
    print(json.dumps(inspect(sys.argv[1], '--height-metric' in sys.argv[2:]), ensure_ascii=True, separators=(',', ':')))
except Exception:
    # Font parsers can include local paths in exceptions. Never transport those.
    sys.stderr.write('Font inspection failed\n')
    sys.exit(1)
