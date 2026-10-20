"""Verify the small Stage 3 API/MCP PDFs; render each page for separate visual review."""
import hashlib, json, re, subprocess, sys
from pathlib import Path
from pypdf import PdfReader

proof = Path(sys.argv[1]).resolve()
poppler = sys.argv[2]
out = proof / "pdf-review"
out.mkdir(exist_ok=True)
cases = []
records = json.loads((proof / "mcp/results.json").read_text(encoding="utf-8"))["results"]
for result in records:
    if "pdf" in result:
        cases.append(("mcp-" + result["name"], Path(result["pdf"]["path"]), result["name"]))
for path in sorted((proof / "api").glob("*.pdf")):
    cases.append(("api-" + path.stem, path, path.stem))
checks = []
for name, path, kind in cases:
    reader = PdfReader(path, strict=True)
    pages = [p.extract_text() for p in reader.pages]
    text = "\n".join(pages)
    tokens = re.findall(r"\bROW\d+\b", text)
    if kind == "auto":
        assert tokens == ["ROW" + str(i) for i in range(8)], (name, tokens)
        assert len(pages) > 1
        assert pages[0].count("GROUP") == 1 and "(ต่อ)" not in pages[0]
        assert all(p.count("GROUP") == 1 and "(ต่อ)" in p for p in pages[1:])
    elif kind == "fixed":
        assert len(pages) == 1 and "(ต่อ)" not in text
        assert 0 < len(tokens) < 12 and tokens == ["ROW" + str(i) for i in range(len(tokens))]
    elif kind == "copies":
        assert text.count("COPY-A") == 1 and text.count("COPY-B") == 1
        assert len(pages) == 2
    prefix = out / name
    subprocess.run([poppler, "-r", "105", "-png", str(path), str(prefix)], check=True, capture_output=True)
    pngs = sorted(out.glob(name + "-*.png"))
    assert len(pngs) == len(pages)
    (out / (name + ".txt")).write_text(text, encoding="utf-8")
    checks.append({"name": name, "path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "pages": len(pages), "tokens": tokens, "rendered": [str(p) for p in pngs], "structural": "PASS", "visual": "pending"})
(out / "checks.json").write_text(json.dumps({"checks": checks, "pageCount": sum(c["pages"] for c in checks)}, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps({"status": "PASS", "pdfs": len(checks), "pages": sum(c["pages"] for c in checks)}))
