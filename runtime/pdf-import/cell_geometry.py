"""Native PDF measurements for table interpretation. Coordinates use PDF points."""
from bisect import bisect_left, bisect_right
from collections import Counter

import pymupdf

from cell_text import has_detached_mark, read_cell


def summarize_runs(seen, rect):
    groups = {}
    for (text, bounds, size, font), count in seen.items():
        box = pymupdf.Rect(bounds)
        equivalents = groups.setdefault((text, size, font), [])
        for entry in equivalents:
            original = pymupdf.Rect(entry["bounds_pt"])
            tolerance = min(1.0, size * .04)
            if (max(abs(a - b) for a, b in zip(box, original)) <= tolerance
                    and (box & original).get_area() >= .85 * max(box.get_area(), original.get_area()) > 0):
                entry["paint_count"] += count
                break
        else:
            equivalents.append({"text": text, "bounds_pt": bounds, "size_pt": size,
                                "font": font, "paint_count": count})
    runs = [run for equivalents in groups.values() for run in equivalents]
    runs.sort(key=lambda run: (run["bounds_pt"][1], run["bounds_pt"][0]))
    result = {"text_runs": runs}
    if runs:
        left = min(run["bounds_pt"][0] for run in runs)
        right = max(run["bounds_pt"][2] for run in runs)
        result["ink_insets_pt"] = {"left": round(left - rect.x0, 2),
                                   "right": round(rect.x1 - right, 2),
                                   "center_offset": round((left + right - rect.x0 - rect.x1) / 2, 2)}
    return result


def page_tables(page):
    tables = page.find_tables().tables
    if not tables:
        return []
    paints = []
    for run in page.get_texttrace():
        if run["type"] not in (0, 1):
            continue
        text = "".join(chr(char[0]) for char in run["chars"]).strip()
        if text:
            box = tuple(round(v, 2) for v in run["bbox"])
            paints.append(((box[1] + box[3]) / 2, text, box, round(run["size"], 2), run["font"]))
    paints.sort(key=lambda item: item[0])
    centers = [item[0] for item in paints]
    observations = []
    for table in tables:
        rows = []
        for row, values in zip(table.rows, table.extract(), strict=True):
            cells = []
            for column, (bounds, value) in enumerate(zip(row.cells, values, strict=True)):
                if bounds is None:
                    continue
                rect = pymupdf.Rect(bounds)
                cell = {"column": column, "bounds_pt": [round(v, 2) for v in rect], "text": value or ""}
                if has_detached_mark(cell["text"]):
                    try:
                        cell["text"] = read_cell(page, rect, cell["text"])
                    except ValueError:
                        cell["review"] = "Verify detached marks against the source image."
                first = bisect_left(centers, rect.y0)
                stop = bisect_right(centers, rect.y1)
                seen = Counter((text, box, size, font) for _, text, box, size, font in paints[first:stop]
                               if rect.x0 <= (box[0] + box[2]) / 2 < rect.x1)
                cell.update(summarize_runs(seen, rect))
                cells.append(cell)
            rows.append(cells)
        observations.append({"bounds_pt": [round(v, 2) for v in table.bbox], "rows": rows})
    return observations
