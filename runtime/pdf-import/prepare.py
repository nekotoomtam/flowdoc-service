import argparse
import hashlib
from io import BytesIO
import json
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ElementTree
from pathlib import Path

import pdfplumber
from PIL import Image, ImageDraw

MAX_BYTES = 20 * 1024 * 1024
MAX_PAGES = 30
MAX_ASSETS = 20


def poppler(program, *args):
    subprocess.run([program, *map(str, args)], capture_output=True, timeout=45, check=True)


def selected_pdf(source, selection, output, scratch):
    with pdfplumber.open(source) as document:
        count = len(document.pages)
    pages = list(range(1, count + 1)) if selection is None else selection
    if not pages or len(pages) > MAX_PAGES or len(set(pages)) != len(pages) or any(p < 1 or p > count for p in pages):
        raise ValueError(f"Select distinct pages in the range 1–{count} (at most {MAX_PAGES})")
    if pages == list(range(1, count + 1)):
        shutil.copyfile(source, output)
    else:
        for page in pages:
            poppler("pdfseparate", "-f", page, "-l", page, source, scratch / "selected-%d.pdf")
        poppler("pdfunite", *(scratch / f"selected-{p}.pdf" for p in pages), output)
    if output.stat().st_size > MAX_BYTES:
        raise ValueError("Selected PDF exceeds the import size limit")
    return pages, count


class Assets:
    def __init__(self, folder):
        self.folder = folder
        self.files = {}

    def add(self, raster):
        buffer = BytesIO()
        raster.save(buffer, format="PNG")
        data = buffer.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        if digest in self.files:
            return self.files[digest]
        if len(self.files) == MAX_ASSETS or len(data) > MAX_BYTES:
            return None
        key = f"asset{len(self.files) + 1}"
        (self.folder / f"{key}.png").write_bytes(data)
        self.files[digest] = key
        return key


def drawing(obj):
    return {k: round(float(obj[k]), 3) for k in ("x0", "top", "x1", "bottom", "linewidth") if obj.get(k) is not None}


def text_observations(page):
    observations = []
    for line in page.extract_text_lines(layout=False, return_chars=True):
        used = {}
        for ch in line["chars"]:
            if ch["text"].strip():
                family = re.sub(r"^[A-Z]{6}\+", "", ch["fontname"])
                style = family, round(ch["size"], 2)
                used[style] = used.get(style, 0) + 1
        if used:
            observations.append({
                "sample": line["text"], "left_pt": round(line["x0"], 2), "top_pt": round(line["top"], 2),
                "font_styles": [
                    {"name": family, "size_pt": size, "non_space_glyphs": count}
                    for (family, size), count in used.items()
                ],
            })
    return observations


def image_observations(page, width, height, assets, scratch):
    observations = []
    for image in page.findall("image"):
        x, y, w, h = (round(float(image.attrib[k]), 3) for k in ("left", "top", "width", "height"))
        if w <= 0 or h <= 0:
            continue
        info = {"pdf_drawn_box_xywh_pt": [x, y, w, h]}
        if w > .95 * width and h > .95 * height:
            info["role_candidate"] = "page-sized raster; verify whether background or scanned page"
        else:
            source = Path(image.attrib["src"])
            if not source.is_absolute():
                source = scratch / source
            source = source.resolve()
            if not source.is_relative_to(scratch.resolve()):
                raise ValueError("Unexpected extracted-image path")
            with Image.open(source) as raster:
                info["asset_pixels"] = list(raster.size)
                # Preserve the drawn aspect ratio, including anisotropic PDF image transforms.
                scale = min(max(raster.width / w, raster.height / h), 2400 / max(w, h))
                img = raster.convert("RGBA").resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)
                key = assets.add(img)
            if key:
                info["prepared_asset_key"] = key
                info["prepared_asset_pixels"] = list(img.size)
        observations.append(info)
    return observations


def source_outlines(page, observations, assets, original_page):
    groups = {}
    for rect in page.rects:
        x, y = rect["x0"], rect["top"]
        w, h = rect["x1"] - x, rect["bottom"] - y
        if not (rect.get("stroke") and not rect.get("fill") and 0 < w <= 32 and 0 < h <= 32):
            continue
        if any(x <= line["left_pt"] < x+w and y <= line["top_pt"] < y+h for line in observations):
            continue
        signature = tuple(round(v * 2) / 2 for v in (w, h, rect.get("linewidth") or .5))
        groups.setdefault(signature, []).append({"page": original_page, "xywh_pt": [x, y, w, h]})
    report = []
    for (w, h, stroke), occurrences in groups.items():
        if len(occurrences) < 2:
            continue
        image = Image.new("RGBA", (max(1, round(w*8)), max(1, round(h*8))), (255, 255, 255, 0))
        ImageDraw.Draw(image).rectangle((0, 0, image.width-1, image.height-1), outline="#000000", width=max(1, round(stroke*8)))
        key = assets.add(image)
        if key:
            report.append({"prepared_asset_key": key, "width_pt": w, "height_pt": h, "stroke_pt": stroke, "occurrences": occurrences})
    return report


def evidence_for(selected, original_pages, assets, scratch):
    geometry = scratch / "positions.xml"
    poppler("pdftohtml", "-xml", "-noroundcoord", "-zoom", "1", "-fmt", "png", selected, geometry)
    poppler("pdftoppm", "-gray", "-r", "288", selected, scratch / "page")
    shapes = ElementTree.parse(geometry).getroot().findall("page")
    canvases = sorted(scratch.glob("page-*.pgm"), key=lambda path: int(path.stem.rsplit("-", 1)[1]))
    result = []
    with pdfplumber.open(selected) as pdf:
        for page, shape, raster, original in zip(pdf.pages, shapes, canvases, original_pages, strict=True):
            text = text_observations(page)
            with Image.open(raster) as bitmap:
                rules = writing_rules(page, bitmap, assets)
            result.append({
                "file_page": page.page_number, "originalPage": original, "page_size_pt": [page.width, page.height],
                "typography_observations": text,
                "vector_lines": [drawing(line) for line in page.lines],
                "vector_rectangles": [
                    {**drawing(rect), "fill": bool(rect.get("fill")), "stroke": bool(rect.get("stroke"))}
                    for rect in page.rects
                ],
                "images": image_observations(shape, page.width, page.height, assets, scratch),
                "source_writing_rules": rules,
                "asset_candidates": source_outlines(page, text, assets, original),
            })
    return {"coordinates": "PDF points from the top left", "pages": result}


def writing_rules(page, bitmap, assets):
    runs = []
    chars = sorted((c for c in page.chars if c["text"] == "_"), key=lambda c: (round(c["top"], 2), c["x0"]))
    for ch in chars:
        if runs and abs(ch["x0"] - runs[-1][-1]["x1"]) < .35 and abs(ch["top"] - runs[-1][-1]["top"]) < .15:
            runs[-1].append(ch)
        else:
            runs.append([ch])
    found = []
    for run in runs:
        if len(run) < 4:
            continue
        x0, x1, bottom = run[0]["x0"], run[-1]["x1"], run[0]["bottom"]
        left, right = max(0, round((x0+1)*4)), min(bitmap.width, round((x1-1)*4))
        if right <= left:
            continue
        raster = bitmap.load()
        ink = [
            y for y in range(max(0, round((bottom-3)*4)), min(bitmap.height, round((bottom+2)*4)))
            if sum(raster[x, y] < 145 for x in range(left, right)) >= .70*(right-left)
        ]
        if ink:
            width, thickness = round(x1-x0, 2), max(.5, len(ink)/4)
            key = assets.add(Image.new("RGBA", (max(1, round(width*8)), round(thickness*8)), (0, 0, 0, 255)))
            found.append({
                "x0_pt": round(x0, 2), "x1_pt": round(x1, 2), "y_pt": (sum(ink)/len(ink)+.5)/4,
                "visible_thickness_pt_approx": thickness, "prepared_asset_key": key,
                "prepared_asset_bbox_width_height_pt": [width, thickness],
            })
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--pages", type=lambda value: [int(page) for page in value.split(",")])
    args = parser.parse_args()
    if args.source.stat().st_size > MAX_BYTES:
        raise ValueError("Source PDF exceeds the import size limit")
    with args.source.open("rb") as source:
        if not source.read(8).startswith(b"%PDF-"):
            raise ValueError("Import requires a PDF")
    args.output = args.output.resolve()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    try:
        with tempfile.TemporaryDirectory() as temp:
            selected = args.output / "selected.pdf"
            pages, count = selected_pdf(args.source.resolve(), args.pages, selected, Path(temp))
            assets = Assets(args.output)
            evidence = evidence_for(selected, pages, assets, Path(temp))
        metadata = {"sourcePageCount": count, "selectedPages": pages, "assets": list(assets.files.values()), "evidence": evidence}
        (args.output / "prepared.json").write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf8")
    except Exception:
        for staged in args.output.iterdir():
            staged.unlink()
        args.output.rmdir()
        raise


if __name__ == "__main__":
    main()
